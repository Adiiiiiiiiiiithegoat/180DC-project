/**
 * DESIGN.md sections 8 and 9 — the read side. The assistant's tools and the
 * dashboard call these same functions, so a chart and an answer cannot
 * disagree.
 *
 * Every figure is computed in SQL: sums, margins, percentages, deltas, means,
 * standard deviations, reorder quantities. JavaScript only renames columns.
 * The model narrates what comes back; it never does the arithmetic.
 *
 * Conventions:
 *   - `userId` is the first argument, from the session, and every query
 *     filters on it in its WHERE clause (never after the fact).
 *   - `now` is the last argument. Callers omit it; tests fix it. Nothing here
 *     reads the clock itself.
 *   - Days are IST calendar days. Sales windows are made of COMPLETE days, so
 *     they end yesterday at the latest: today is still trading, and a partial
 *     day compared with a whole one is a false dip (section 9). The exception
 *     is `includeToday`, for questions about today, which is labelled partial
 *     and compared like for like (see windowCte). Charts never use it.
 *   - Money is integer paise, and every money field's name ends in `Paise`.
 *     The assistant formats those fields into rupees before the model sees
 *     them (see assistant.ts), so the model never divides by 100 either.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { ServiceError } from "./services";
import {
  findProductInputSchema,
  inventoryStatusInputSchema,
  productPerformanceInputSchema,
  salesSummaryInputSchema,
  salesTimeSeriesInputSchema,
  stockHistoryInputSchema,
} from "./validation";

// ponytail: one shop, one timezone. A per-account timezone column is the
// upgrade the day a second country signs up.
const TZ = "Asia/Kolkata";

/** The IST calendar day that `now` falls on. */
const todayIst = (now: Date) => sql`(${now.toISOString()}::timestamptz AT TIME ZONE ${TZ})::date`;

/** The instant an IST day starts. Range filters use this so they can use the (user_id, sold_at) index. */
const startOf = (day: SQL) => sql`((${day})::timestamp AT TIME ZONE ${TZ})`;

/** `a` as a percentage of `b`, one decimal place; null when `b` is zero. */
const pctOf = (a: SQL, b: SQL) => sql`ROUND((${a}) * 100.0 / NULLIF(${b}, 0), 1)::float8`;

/** Percentage change from `prev` to `cur`; null when there was nothing before. */
const pctChange = (cur: SQL, prev: SQL) => pctOf(sql`${cur} - ${prev}`, prev);

/**
 * One row: the window's first and last day, its length, and the instants that
 * bound it and the equal window before it (`cur_from`..`cur_to`,
 * `prev_from`..`prev_to`).
 *
 * By default it ends on `endDate` or yesterday, whichever is earlier, so a
 * window never includes today's unfinished trading. `includeToday` is the one
 * exception, for when someone asks about today: the window then ends now, and
 * the previous window ends at the same time of day `days` days earlier, so a
 * partial day is compared with the same part of a day, never with a whole one.
 */
function windowCte(days: number, endDate: string | undefined, now: Date, includeToday = false) {
  const at = sql`${now.toISOString()}::timestamptz`;
  const toDay = includeToday
    ? todayIst(now)
    : sql`LEAST(COALESCE(${endDate ?? null}::date, ${todayIst(now)} - 1), ${todayIst(now)} - 1)`;
  return sql`win AS (
    SELECT e.from_day, e.to_day, ${days}::int AS days,
           ${startOf(sql`e.from_day`)} AS cur_from,
           ${includeToday ? at : startOf(sql`e.to_day + 1`)} AS cur_to,
           ${startOf(sql`e.from_day - ${days}::int`)} AS prev_from,
           ${includeToday ? sql`${at} - make_interval(days => ${days}::int)` : startOf(sql`e.from_day`)} AS prev_to
      FROM (SELECT d.to_day - ${days - 1}::int AS from_day, d.to_day FROM (SELECT ${toDay} AS to_day) d) e
  )`;
}

/** Sales in the window or the one before it; `cur` says which. */
const inWindows = (soldAt: SQL) =>
  sql`${soldAt} >= win.prev_from AND ${soldAt} < win.cur_to AND (${soldAt} < win.prev_to OR ${soldAt} >= win.cur_from)`;

/** For a partial window, what the model is told: which part of which days it covers. */
const partialNote = (upTo: string) =>
  `PARTIAL: includes today's trading up to ${upTo} IST; the previous period is cut at the same time of day`;

type Row = Record<string, unknown>;
const rows = async <T extends Row>(query: SQL) => (await db.execute<T>(query)).rows;

// ---------------------------------------------------------------------------

/** "Blue mugs" to a product id: SKU exact first, then trigram similarity, in Postgres. */
export async function findProduct(userId: string, rawInput: unknown) {
  const { query } = findProductInputSchema.parse(rawInput);
  const found = await rows<{
    id: string; name: string; sku: string; category: string | null;
    on_hand: number; unit_price: number; is_active: boolean; match: number;
  }>(sql`
    SELECT id, name, sku, category, quantity_on_hand AS on_hand, unit_price, is_active,
           ROUND(GREATEST(similarity(name, ${query}), word_similarity(${query}, name))::numeric, 2)::float8 AS match
      FROM products
     WHERE user_id = ${userId}
       AND (lower(sku) = lower(${query}) OR word_similarity(${query}, name) >= 0.3)
     ORDER BY lower(sku) = lower(${query}) DESC, match DESC, name
     LIMIT 5`);
  return {
    query,
    candidates: found.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      category: p.category,
      onHand: p.on_hand,
      unitPricePaise: p.unit_price,
      isActive: p.is_active,
      match: p.match,
    })),
  };
}

/** Stock levels, reorder points and stock value on hand. Active products only. */
export async function getInventoryStatus(userId: string, rawInput: unknown = {}) {
  const { filter } = inventoryStatusInputSchema.parse(rawInput);
  const status = sql`CASE WHEN quantity_on_hand = 0 THEN 'out'
                          WHEN quantity_on_hand <= reorder_point THEN 'low'
                          ELSE 'ok' END`;
  const items = await rows<{
    id: string; name: string; sku: string; category: string | null; on_hand: number;
    reorder_point: number; lead_time_days: number; unit_price: number; average_cost: number;
    value_at_cost: number; value_at_retail: number; status: "out" | "low" | "ok";
  }>(sql`
    SELECT id, name, sku, category, quantity_on_hand AS on_hand, reorder_point, lead_time_days,
           unit_price, average_cost,
           quantity_on_hand::bigint * average_cost AS value_at_cost,
           quantity_on_hand::bigint * unit_price   AS value_at_retail,
           ${status} AS status
      FROM products
     WHERE user_id = ${userId} AND is_active
       AND (${filter} = 'all'
            OR (${filter} = 'low' AND quantity_on_hand <= reorder_point)
            OR (${filter} = 'out' AND quantity_on_hand = 0))
     ORDER BY quantity_on_hand > reorder_point, quantity_on_hand = 0 DESC, name`);

  // Shop-wide totals are over every active product, whatever the filter.
  const [totals] = await rows<{
    products: number; units: number; value_at_cost: number; value_at_retail: number; low: number; out: number;
  }>(sql`
    SELECT COUNT(*) AS products,
           COALESCE(SUM(quantity_on_hand), 0)::bigint AS units,
           COALESCE(SUM(quantity_on_hand::bigint * average_cost), 0)::bigint AS value_at_cost,
           COALESCE(SUM(quantity_on_hand::bigint * unit_price), 0)::bigint AS value_at_retail,
           COUNT(*) FILTER (WHERE quantity_on_hand <= reorder_point) AS low,
           COUNT(*) FILTER (WHERE quantity_on_hand = 0) AS out
      FROM products
     WHERE user_id = ${userId} AND is_active`);

  return {
    filter,
    totals: {
      activeProducts: totals.products,
      unitsOnHand: totals.units,
      stockValueAtCostPaise: totals.value_at_cost,
      stockValueAtRetailPaise: totals.value_at_retail,
      atOrBelowReorderPoint: totals.low,
      outOfStock: totals.out,
    },
    items: items.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      category: p.category,
      onHand: p.on_hand,
      reorderPoint: p.reorder_point,
      leadTimeDays: p.lead_time_days,
      status: p.status,
      unitPricePaise: p.unit_price,
      averageCostPaise: p.average_cost,
      stockValueAtCostPaise: p.value_at_cost,
    })),
  };
}

/**
 * Revenue, cost of goods, margin, transactions, units, average basket and
 * discounts for a window, and the same for the equal window before it, with
 * the deltas — all in one statement, so the comparison is SQL's, not the
 * model's.
 *
 * Revenue is `sales.total` and cost is `sales.cost_total`: the figures stamped
 * at the moment of sale, never recomputed from today's prices (section 4).
 * Units include free promotional units — they left the shelf.
 */
export async function getSalesSummary(userId: string, rawInput: unknown = {}, now = new Date()) {
  const input = salesSummaryInputSchema.parse(rawInput);
  const [r] = await rows<Row & Record<string, number | string | null>>(sql`
    WITH ${windowCte(input.days, input.endDate, now, input.includeToday)},
    s AS (
      SELECT sa.total, sa.cost_total, sa.discount_total,
             sa.sold_at >= win.cur_from AS cur,
             (SELECT SUM(l.quantity) FROM sale_lines l WHERE l.sale_id = sa.id) AS units
        FROM sales sa, win
       WHERE sa.user_id = ${userId}
         AND ${inWindows(sql`sa.sold_at`)}
    ),
    t AS (
      SELECT COALESCE(SUM(total)          FILTER (WHERE cur), 0)::bigint AS revenue,
             COALESCE(SUM(cost_total)     FILTER (WHERE cur), 0)::bigint AS cogs,
             COUNT(*)                     FILTER (WHERE cur)             AS transactions,
             COALESCE(SUM(units)          FILTER (WHERE cur), 0)::bigint AS units,
             COALESCE(SUM(discount_total) FILTER (WHERE cur), 0)::bigint AS discounts,
             COALESCE(SUM(total)          FILTER (WHERE NOT cur), 0)::bigint AS p_revenue,
             COALESCE(SUM(cost_total)     FILTER (WHERE NOT cur), 0)::bigint AS p_cogs,
             COUNT(*)                     FILTER (WHERE NOT cur)             AS p_transactions,
             COALESCE(SUM(units)          FILTER (WHERE NOT cur), 0)::bigint AS p_units,
             COALESCE(SUM(discount_total) FILTER (WHERE NOT cur), 0)::bigint AS p_discounts
        FROM s
    ),
    m AS (
      SELECT t.*,
             t.revenue - t.cogs     AS margin,
             t.p_revenue - t.p_cogs AS p_margin,
             ROUND(t.revenue::numeric   / NULLIF(t.transactions, 0))::bigint   AS basket,
             ROUND(t.p_revenue::numeric / NULLIF(t.p_transactions, 0))::bigint AS p_basket
        FROM t
    )
    SELECT win.from_day::text AS from_day, win.to_day::text AS to_day, win.days,
           (win.from_day - win.days)::text AS p_from_day,
           ((win.prev_to - interval '1 microsecond') AT TIME ZONE ${TZ})::date::text AS p_to_day,
           to_char(win.cur_to AT TIME ZONE ${TZ}, 'HH24:MI') AS up_to,
           m.*,
           m.revenue - m.p_revenue           AS revenue_change,
           m.margin - m.p_margin             AS margin_change,
           m.transactions - m.p_transactions AS transactions_change,
           m.units - m.p_units               AS units_change,
           ${pctOf(sql`m.margin`, sql`m.revenue`)}     AS margin_pct,
           ${pctOf(sql`m.p_margin`, sql`m.p_revenue`)} AS p_margin_pct,
           ${pctChange(sql`m.revenue`, sql`m.p_revenue`)}           AS revenue_change_pct,
           ${pctChange(sql`m.margin`, sql`m.p_margin`)}             AS margin_change_pct,
           ${pctChange(sql`m.transactions`, sql`m.p_transactions`)} AS transactions_change_pct,
           ${pctChange(sql`m.units`, sql`m.p_units`)}               AS units_change_pct,
           ${pctChange(sql`m.basket`, sql`m.p_basket`)}             AS basket_change_pct,
           ROUND(m.margin * 100.0 / NULLIF(m.revenue, 0)
                 - m.p_margin * 100.0 / NULLIF(m.p_revenue, 0), 1)::float8 AS margin_pct_points_change
      FROM win, m`);

  const totals = (p: "" | "p_") => ({
    revenuePaise: r[`${p}revenue`] as number,
    costOfGoodsPaise: r[`${p}cogs`] as number,
    grossMarginPaise: r[`${p}margin`] as number,
    grossMarginPct: r[`${p}margin_pct`] as number | null,
    transactions: r[`${p}transactions`] as number,
    units: r[`${p}units`] as number,
    averageBasketPaise: r[`${p}basket`] as number | null,
    discountsPaise: r[`${p}discounts`] as number,
  });

  const current = {
    ...(input.includeToday && { partial: partialNote(r.up_to as string) }),
    period: { from: r.from_day as string, to: r.to_day as string, days: r.days as number },
    ...totals(""),
  };
  if (!input.compareToPrevious) return current;
  return {
    ...current,
    previousPeriod: { period: { from: r.p_from_day as string, to: r.p_to_day as string }, ...totals("p_") },
    change: {
      revenuePaise: r.revenue_change as number,
      revenuePct: r.revenue_change_pct as number | null,
      grossMarginPaise: r.margin_change as number,
      grossMarginPct: r.margin_change_pct as number | null,
      grossMarginPctPoints: r.margin_pct_points_change as number | null,
      transactions: r.transactions_change as number,
      transactionsPct: r.transactions_change_pct as number | null,
      units: r.units_change as number,
      unitsPct: r.units_change_pct as number | null,
      averageBasketPct: r.basket_change_pct as number | null,
    },
  };
}

/**
 * Revenue, units and transactions per day or ISO week (Monday start).
 *
 * Complete periods only (section 9): a bucket is returned only when every day
 * of it lies inside the window AND inside the shop's trading history, which
 * starts at its first sale. The seeded history starts and ends mid-week, and a
 * live account always has a week in progress; either would plot as a false
 * dip. A complete bucket with no sales is still returned, as zero — that one
 * is real.
 */
export async function getSalesTimeSeries(userId: string, rawInput: unknown = {}, now = new Date()) {
  const input = salesTimeSeriesInputSchema.parse(rawInput);
  const weekly = input.granularity === "week";
  const points = await rows<{ start: string; end: string; revenue: number; units: number; transactions: number }>(sql`
    WITH ${windowCte(input.days, input.endDate, now)},
    first_sale AS (
      SELECT (MIN(sold_at) AT TIME ZONE ${TZ})::date AS day FROM sales WHERE user_id = ${userId}
    ),
    buckets AS (
      SELECT g::date AS bucket_start, g::date + ${weekly ? 6 : 0}::int AS bucket_end
        FROM win, generate_series(
               ${weekly ? sql`date_trunc('week', win.from_day::timestamp)` : sql`win.from_day::timestamp`},
               win.to_day::timestamp,
               ${weekly ? "1 week" : "1 day"}::interval) g
    ),
    complete AS (
      SELECT b.* FROM buckets b, win, first_sale f
       WHERE b.bucket_start >= GREATEST(win.from_day, f.day)
         AND b.bucket_end   <= win.to_day
    ),
    s AS (
      SELECT (sa.sold_at AT TIME ZONE ${TZ})::date AS day, sa.total,
             (SELECT SUM(l.quantity) FROM sale_lines l WHERE l.sale_id = sa.id) AS units
        FROM sales sa, win
       WHERE sa.user_id = ${userId}
         AND sa.sold_at >= ${startOf(sql`win.from_day`)}
         AND sa.sold_at <  ${startOf(sql`win.to_day + 1`)}
    )
    SELECT c.bucket_start::text AS start, c.bucket_end::text AS "end",
           COALESCE(SUM(s.total), 0)::bigint AS revenue,
           COALESCE(SUM(s.units), 0)::bigint AS units,
           COUNT(s.day) AS transactions
      FROM complete c
      LEFT JOIN s ON s.day BETWEEN c.bucket_start AND c.bucket_end
     GROUP BY c.bucket_start, c.bucket_end
     ORDER BY c.bucket_start`);

  return {
    granularity: input.granularity,
    points: points.map((p) => ({
      start: p.start,
      end: p.end,
      revenuePaise: p.revenue,
      units: p.units,
      transactions: p.transactions,
    })),
  };
}

const PERFORMANCE_ORDER = {
  revenue: sql`revenue DESC, name`,
  units: sql`units DESC, name`,
  biggest_decline: sql`revenue_change ASC, name`,
  biggest_growth: sql`revenue_change DESC, name`,
  // Velocity: units sold against the equal window before (both are the same
  // length, so this is units per day, scaled). Units, not revenue, so a price
  // change or a promotion does not read as a product selling faster.
  speeding_up: sql`units - p_units DESC, name`,
  slowing_down: sql`units - p_units ASC, name`,
} as const;

/**
 * Per product, for a window and the equal window before it: units, revenue,
 * margin, velocity, and what promotions gave away. Every product is included,
 * even one that sold nothing — that is how dead stock shows up without a tool
 * of its own. Deactivated products appear only if they sold in either window.
 *
 * Line revenue = quantity x charged price - discount amount (section 6).
 */
export async function getProductPerformance(userId: string, rawInput: unknown = {}, now = new Date()) {
  const input = productPerformanceInputSchema.parse(rawInput);
  const found = await rows<{
    id: string; name: string; is_active: boolean;
    units: number; revenue: number; cost: number; margin: number; margin_pct: number | null;
    units_per_day: number; p_units: number; p_revenue: number; p_units_per_day: number;
    revenue_change: number; revenue_change_pct: number | null; units_change_pct: number | null;
    free_units: number; discounts: number; p_free_units: number; p_discounts: number;
    live_promotion: string | null;
    from_day: string; to_day: string; p_from_day: string; p_to_day: string; up_to: string;
  }>(sql`
    WITH ${windowCte(input.days, input.endDate, now, input.includeToday)},
    lines AS (
      SELECT l.product_id,
             sa.sold_at >= win.cur_from AS cur,
             l.quantity,
             l.quantity::bigint * l.charged_price - l.discount_amount AS revenue,
             l.quantity::bigint * l.unit_cost AS cost,
             l.quantity::bigint * (l.list_price - l.charged_price) + l.discount_amount AS discount,
             CASE WHEN l.is_free_unit THEN l.quantity ELSE 0 END AS free_units
        FROM sale_lines l
        JOIN sales sa ON sa.id = l.sale_id, win
       WHERE sa.user_id = ${userId}
         AND ${inWindows(sql`sa.sold_at`)}
    ),
    a AS (
      SELECT product_id,
             COALESCE(SUM(quantity)   FILTER (WHERE cur), 0)::bigint AS units,
             COALESCE(SUM(revenue)    FILTER (WHERE cur), 0)::bigint AS revenue,
             COALESCE(SUM(cost)       FILTER (WHERE cur), 0)::bigint AS cost,
             COALESCE(SUM(discount)   FILTER (WHERE cur), 0)::bigint AS discounts,
             COALESCE(SUM(free_units) FILTER (WHERE cur), 0)::bigint AS free_units,
             COALESCE(SUM(quantity)   FILTER (WHERE NOT cur), 0)::bigint AS p_units,
             COALESCE(SUM(revenue)    FILTER (WHERE NOT cur), 0)::bigint AS p_revenue,
             COALESCE(SUM(discount)   FILTER (WHERE NOT cur), 0)::bigint AS p_discounts,
             COALESCE(SUM(free_units) FILTER (WHERE NOT cur), 0)::bigint AS p_free_units
        FROM lines GROUP BY product_id
    ),
    perf AS (
      SELECT p.id, p.name, p.is_active,
             COALESCE(a.units, 0) AS units, COALESCE(a.revenue, 0) AS revenue, COALESCE(a.cost, 0) AS cost,
             COALESCE(a.discounts, 0) AS discounts, COALESCE(a.free_units, 0) AS free_units,
             COALESCE(a.p_units, 0) AS p_units, COALESCE(a.p_revenue, 0) AS p_revenue,
             COALESCE(a.p_discounts, 0) AS p_discounts, COALESCE(a.p_free_units, 0) AS p_free_units
        FROM products p
        LEFT JOIN a ON a.product_id = p.id
       WHERE p.user_id = ${userId}
         AND (p.is_active OR a.product_id IS NOT NULL)
    )
    SELECT perf.*,
           perf.revenue - perf.cost AS margin,
           ${pctOf(sql`perf.revenue - perf.cost`, sql`perf.revenue`)} AS margin_pct,
           ROUND(perf.units::numeric / win.days, 2)::float8   AS units_per_day,
           ROUND(perf.p_units::numeric / win.days, 2)::float8 AS p_units_per_day,
           perf.revenue - perf.p_revenue AS revenue_change,
           ${pctChange(sql`perf.revenue`, sql`perf.p_revenue`)} AS revenue_change_pct,
           ${pctChange(sql`perf.units`, sql`perf.p_units`)}     AS units_change_pct,
           (SELECT CASE pr.type WHEN 'percent_off' THEN pr.percent || '% off'
                                ELSE 'buy ' || pr.buy_qty || ' get ' || pr.get_qty || ' free' END
                   || ', ' || (pr.starts_at AT TIME ZONE ${TZ})::date
                   || ' to ' || (pr.ends_at AT TIME ZONE ${TZ})::date
              FROM promotions pr
             WHERE pr.user_id = ${userId} AND pr.product_id = perf.id AND pr.is_active
               AND pr.starts_at <= ${now.toISOString()}::timestamptz
               AND pr.ends_at   >  ${now.toISOString()}::timestamptz
             ORDER BY pr.priority, pr.id LIMIT 1) AS live_promotion,
           win.from_day::text AS from_day, win.to_day::text AS to_day,
           (win.from_day - win.days)::text AS p_from_day,
           ((win.prev_to - interval '1 microsecond') AT TIME ZONE ${TZ})::date::text AS p_to_day,
           to_char(win.cur_to AT TIME ZONE ${TZ}, 'HH24:MI') AS up_to
      FROM perf, win
     ORDER BY ${PERFORMANCE_ORDER[input.sortBy]}`);

  const first = found[0];
  return {
    ...(input.includeToday && first && { partial: partialNote(first.up_to) }),
    period: first ? { from: first.from_day, to: first.to_day, days: input.days } : null,
    previousPeriod: first ? { from: first.p_from_day, to: first.p_to_day } : null,
    sortedBy: input.sortBy,
    // `limit` trims the product list only. Anything that gave value away —
    // a promotion, or a sale-level discount — is listed whatever the limit, so
    // a margin change can be traced to it even when those products are not
    // among the biggest movers.
    promotionsAndDiscounts: found
      .filter((p) => p.live_promotion !== null || p.discounts > 0 || p.p_discounts > 0)
      .map((p) => ({
        product: p.name,
        livePromotion: p.live_promotion,
        discountsGivenPaise: p.discounts,
        previousDiscountsGivenPaise: p.p_discounts,
        freeUnits: p.free_units,
        previousFreeUnits: p.p_free_units,
      })),
    products: found.slice(0, input.limit).map((p) => ({
      id: p.id,
      name: p.name,
      isActive: p.is_active,
      units: p.units,
      unitsPerDay: p.units_per_day,
      revenuePaise: p.revenue,
      grossMarginPaise: p.margin,
      grossMarginPct: p.margin_pct,
      previousUnits: p.p_units,
      previousUnitsPerDay: p.p_units_per_day,
      previousRevenuePaise: p.p_revenue,
      revenueChangePaise: p.revenue_change,
      revenueChangePct: p.revenue_change_pct,
      unitsChangePct: p.units_change_pct,
      freeUnits: p.free_units,
      discountsGivenPaise: p.discounts,
      livePromotion: p.live_promotion,
    })),
  };
}

// DESIGN.md section 8, reorder methodology. Stated plainly, never claimed optimal.
const TRAILING_DAYS = 30;
const MIN_HISTORY_DAYS = 14;
/**
 * Buffer factor. 1.65 is the one-sided 95% point of a normal distribution, so
 * the buffer covers demand over the lead time about 95% of the time: roughly
 * a 95% service level. Only roughly — daily sales are neither normal nor
 * independent — so it is stated as approximate, never as a guarantee.
 */
const K = 1.65;

/**
 * Per active product: mean and standard deviation of daily units sold over the
 * trailing 30 complete days (days with no sales count as zero), then
 *
 *   suggested reorder point = ceil(mean x L + k x std dev x sqrt(L)), L = lead time in days
 *
 * The buffer scales with sqrt(L), not L and not 1: demand over L days is the
 * sum of L daily demands, so its variance is L times a day's and its standard
 * deviation sqrt(L) times. `k x std dev` alone understates the buffer for any
 * lead time over a day.
 *
 *   suggested order quantity = what it takes to get back up to that point
 *   days to stockout         = on hand / mean
 *
 * History is counted from the product's first stock movement — the day it
 * went on the shelf — not its first sale, so a product that has sat unsold for
 * two months has two months of (zero) history. Under 14 days of history
 * returns `insufficient_history` and no numbers: a standard deviation over a
 * few days is noise, and declining to answer beats a confident wrong one.
 */
export async function getReorderSuggestions(userId: string, now = new Date()) {
  const found = await rows<{
    id: string; name: string; sku: string; on_hand: number; reorder_point: number; lead_time_days: number;
    history_days: number; window_days: number | null; units_sold: number | null;
    mean: number | null; std_dev: number | null;
    suggested_reorder_point: number | null; suggested_order_quantity: number | null;
    days_to_stockout: number | null; status: "insufficient_history" | "reorder_now" | "ok";
  }>(sql`
    WITH y AS (SELECT ${todayIst(now)} - 1 AS yesterday),
    first_move AS (
      SELECT product_id, (MIN(created_at) AT TIME ZONE ${TZ})::date AS day
        FROM stock_movements WHERE user_id = ${userId} GROUP BY product_id
    ),
    h AS (
      SELECT p.id, p.name, p.sku, p.quantity_on_hand AS on_hand, p.reorder_point, p.lead_time_days,
             GREATEST(0, COALESCE(y.yesterday - f.day + 1, 0)) AS history_days, y.yesterday
        FROM products p CROSS JOIN y
        LEFT JOIN first_move f ON f.product_id = p.id
       WHERE p.user_id = ${userId} AND p.is_active
    ),
    days AS (
      SELECT h.id, g::date AS day
        FROM h, generate_series(
               (h.yesterday - LEAST(h.history_days, ${TRAILING_DAYS}) + 1)::timestamp,
               h.yesterday::timestamp, '1 day'::interval) g
       WHERE h.history_days >= ${MIN_HISTORY_DAYS}
    ),
    sold AS (
      SELECT l.product_id, (sa.sold_at AT TIME ZONE ${TZ})::date AS day, SUM(l.quantity) AS units
        FROM sale_lines l JOIN sales sa ON sa.id = l.sale_id, y
       WHERE sa.user_id = ${userId}
         AND sa.sold_at >= ${startOf(sql`y.yesterday - ${TRAILING_DAYS - 1}::int`)}
         AND sa.sold_at <  ${startOf(sql`y.yesterday + 1`)}
       GROUP BY 1, 2
    ),
    stats AS (
      SELECT d.id, COUNT(*) AS window_days, SUM(COALESCE(s.units, 0))::bigint AS units_sold,
             AVG(COALESCE(s.units, 0)) AS mean, STDDEV_SAMP(COALESCE(s.units, 0)) AS std_dev
        FROM days d LEFT JOIN sold s ON s.product_id = d.id AND s.day = d.day
       GROUP BY d.id
    ),
    r AS (
      SELECT h.*, st.window_days, st.units_sold, st.mean, st.std_dev,
             CEIL(st.mean * h.lead_time_days
                  + ${K}::numeric * st.std_dev * SQRT(h.lead_time_days::numeric))::int AS suggested_reorder_point
        FROM h LEFT JOIN stats st ON st.id = h.id
    )
    SELECT id, name, sku, on_hand, reorder_point, lead_time_days, history_days, window_days, units_sold,
           ROUND(mean, 2)::float8 AS mean, ROUND(std_dev, 2)::float8 AS std_dev,
           suggested_reorder_point,
           GREATEST(0, suggested_reorder_point - on_hand) AS suggested_order_quantity,
           CASE WHEN mean > 0 THEN ROUND(on_hand / mean, 1)::float8 END AS days_to_stockout,
           CASE WHEN history_days < ${MIN_HISTORY_DAYS} THEN 'insufficient_history'
                WHEN on_hand <= suggested_reorder_point THEN 'reorder_now'
                ELSE 'ok' END AS status
      FROM r
     ORDER BY CASE WHEN history_days < ${MIN_HISTORY_DAYS} THEN 1
                   WHEN on_hand <= suggested_reorder_point THEN 0 ELSE 2 END,
              on_hand / NULLIF(mean, 0) NULLS LAST, name`);

  return {
    method: {
      formula: "suggested reorder point = ceil(mean daily units × L + k × std dev of daily units × √L), L = lead time in days",
      whySqrtL: "demand over L days has L times the variance of one day's, so its std dev is √L times a day's",
      trailingDays: TRAILING_DAYS,
      k: K,
      kMeans: "approximately a 95% service level (1.65 is the one-sided 95% point of a normal distribution)",
      minimumHistoryDays: MIN_HISTORY_DAYS,
    },
    products: found.map((p) =>
      p.status === "insufficient_history"
        ? {
            id: p.id,
            name: p.name,
            sku: p.sku,
            status: p.status,
            reason: `insufficient history: ${p.history_days} days on the shelf, ${MIN_HISTORY_DAYS} needed`,
            historyDays: p.history_days,
            onHand: p.on_hand,
            currentReorderPoint: p.reorder_point,
          }
        : {
            id: p.id,
            name: p.name,
            sku: p.sku,
            status: p.status,
            suggestedReorderPoint: p.suggested_reorder_point,
            suggestedOrderQuantity: p.suggested_order_quantity,
            daysToStockout: p.days_to_stockout,
            inputs: {
              onHand: p.on_hand,
              currentReorderPoint: p.reorder_point,
              leadTimeDays: p.lead_time_days,
              meanDailyUnits: p.mean,
              stdDevDailyUnits: p.std_dev,
              daysInWindow: p.window_days,
              unitsSoldInWindow: p.units_sold,
              historyDays: p.history_days,
            },
          },
    ),
  };
}

/**
 * The ledger for one product, summarised per IST day by reason, with the
 * running balance — "why do I only have three left?". Unlike the sales
 * windows this runs up to now, today included: it is a ledger, and its last
 * closing balance must equal what is on the shelf.
 */
export async function getStockHistory(userId: string, rawInput: unknown, now = new Date()) {
  const input = stockHistoryInputSchema.parse(rawInput);
  const [product] = await rows<{ id: string; name: string; on_hand: number; from_day: string }>(sql`
    SELECT id, name, quantity_on_hand AS on_hand, (${todayIst(now)} - ${input.days - 1}::int)::text AS from_day
      FROM products WHERE id = ${input.productId} AND user_id = ${userId}`);
  if (!product) throw new ServiceError("not_found", "no such product for this account");

  const from = sql`${product.from_day}::date`;
  const [opening] = await rows<{ qty: number }>(sql`
    SELECT COALESCE(SUM(quantity), 0)::bigint AS qty FROM stock_movements
     WHERE user_id = ${userId} AND product_id = ${input.productId} AND created_at < ${startOf(from)}`);

  const days = await rows<{
    day: string; received: number; sold: number; returned: number; adjusted: number; closing: number;
  }>(sql`
    WITH d AS (
      SELECT (created_at AT TIME ZONE ${TZ})::date AS day,
             COALESCE(SUM(quantity) FILTER (WHERE reason = 'receipt'), 0)::bigint     AS received,
             COALESCE(-SUM(quantity) FILTER (WHERE reason = 'sale'), 0)::bigint       AS sold,
             COALESCE(SUM(quantity) FILTER (WHERE reason = 'return'), 0)::bigint      AS returned,
             COALESCE(SUM(quantity) FILTER (WHERE reason = 'adjustment'), 0)::bigint  AS adjusted,
             SUM(quantity) AS net
        FROM stock_movements
       WHERE user_id = ${userId} AND product_id = ${input.productId} AND created_at >= ${startOf(from)}
       GROUP BY 1
    )
    SELECT d.day::text AS day, d.received, d.sold, d.returned, d.adjusted,
           (${opening.qty}::bigint + SUM(d.net) OVER (ORDER BY d.day))::bigint AS closing
      FROM d ORDER BY d.day`);

  const adjustments = await rows<{ day: string; quantity: number; note: string | null }>(sql`
    SELECT (created_at AT TIME ZONE ${TZ})::date::text AS day, quantity, note FROM stock_movements
     WHERE user_id = ${userId} AND product_id = ${input.productId} AND reason = 'adjustment'
       AND created_at >= ${startOf(from)}
     ORDER BY created_at`);

  return {
    product: { id: product.id, name: product.name, onHandNow: product.on_hand },
    from: product.from_day,
    openingBalance: opening.qty,
    days,
    adjustments,
  };
}
