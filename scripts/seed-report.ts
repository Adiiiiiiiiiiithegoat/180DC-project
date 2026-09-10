/**
 * Prints the seeded shop's numbers, every one computed in SQL, so they can be
 * sanity-checked against what a real small shop looks like.
 *
 *   npm run seed:report
 */
import "./env";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { formatPaise } from "../src/lib/money";
import { DEMO } from "./seed-account";

type Row = Record<string, unknown>;
const q = async <T extends Row>(query: ReturnType<typeof sql>) => (await db.execute<T>(query)).rows;
const rs = (n: unknown) => formatPaise(Number(n));
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const lpad = (s: unknown, n: number) => String(s).padStart(n);

const DAY_IST = sql`(s.sold_at AT TIME ZONE 'Asia/Kolkata')::date`;
const TODAY_IST = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;

async function main() {
  const [user] = await q<{ id: string }>(sql`SELECT id FROM users WHERE email = ${DEMO.email}`);
  if (!user) throw new Error("no demo account; run npm run seed first");
  const u = user.id;

  console.log("\n== Last 30 days vs the 30 before ==");
  const periods = await q<Row>(sql`
    SELECT period, SUM(total) AS revenue, SUM(cost_total) AS cogs,
           COUNT(*) AS transactions, SUM(units) AS units
      FROM (SELECT s.total, s.cost_total,
                   CASE WHEN ${DAY_IST} >= ${TODAY_IST} - 30 THEN 'last 30' ELSE 'prior 30' END AS period,
                   (SELECT SUM(l.quantity) FROM sale_lines l WHERE l.sale_id = s.id) AS units
              FROM sales s
             WHERE s.user_id = ${u} AND ${DAY_IST} >= ${TODAY_IST} - 60) x
     GROUP BY period ORDER BY period`);
  for (const p of periods) {
    const rev = Number(p.revenue);
    const margin = rev - Number(p.cogs);
    console.log(
      `  ${pad(p.period, 9)} revenue ${lpad(rs(rev), 13)}  COGS ${lpad(rs(p.cogs), 13)}  ` +
        `gross margin ${lpad(rs(margin), 12)} (${((margin / rev) * 100).toFixed(1)}%)  ` +
        `${p.transactions} sales, ${p.units} units, avg basket ${rs(Math.round(rev / Number(p.transactions)))}`,
    );
  }

  console.log("\n== Weekly rhythm: average revenue per trading day, by IST weekday (90 days) ==");
  const weekdays = await q<Row>(sql`
    SELECT to_char(day, 'Dy') AS dow, EXTRACT(ISODOW FROM day) AS n,
           ROUND(AVG(revenue))::int AS avg_revenue, ROUND(AVG(sales))::int AS avg_sales
      FROM (SELECT ${DAY_IST} AS day, SUM(s.total) AS revenue, COUNT(*) AS sales
              FROM sales s WHERE s.user_id = ${u} GROUP BY 1) d
     GROUP BY 1, 2 ORDER BY 2`);
  const maxW = Math.max(...weekdays.map((w) => Number(w.avg_revenue)));
  for (const w of weekdays) {
    const bar = "#".repeat(Math.round((Number(w.avg_revenue) / maxW) * 30));
    console.log(`  ${w.dow}  ${lpad(rs(w.avg_revenue), 11)}  ${lpad(w.avg_sales, 3)} sales/day  ${bar}`);
  }

  console.log("\n== Weekly revenue (IST weeks, oldest first) ==");
  const weeks = await q<Row>(sql`
    SELECT date_trunc('week', ${DAY_IST})::date AS week, SUM(s.total) AS revenue
      FROM sales s WHERE s.user_id = ${u} GROUP BY 1 ORDER BY 1`);
  const maxWk = Math.max(...weeks.map((w) => Number(w.revenue)));
  for (const w of weeks) {
    const bar = "#".repeat(Math.round((Number(w.revenue) / maxWk) * 40));
    console.log(`  ${String(w.week).slice(0, 10)}  ${lpad(rs(w.revenue), 13)}  ${bar}`);
  }

  console.log("\n== Product shapes: units sold per 30-day block, and days with any sale ==");
  const shapes = await q<Row>(sql`
    SELECT p.name,
           SUM(l.quantity) FILTER (WHERE ${DAY_IST} <  ${TODAY_IST} - 60) AS first30,
           SUM(l.quantity) FILTER (WHERE ${DAY_IST} >= ${TODAY_IST} - 60 AND ${DAY_IST} < ${TODAY_IST} - 30) AS middle30,
           SUM(l.quantity) FILTER (WHERE ${DAY_IST} >= ${TODAY_IST} - 30) AS last30,
           COUNT(DISTINCT ${DAY_IST}) AS days_with_sales
      FROM products p
      LEFT JOIN sale_lines l ON l.product_id = p.id
      LEFT JOIN sales s ON s.id = l.sale_id
     WHERE p.user_id = ${u}
     GROUP BY p.name ORDER BY p.name`);
  console.log(`  ${pad("product", 24)} ${lpad("d1-30", 6)} ${lpad("d31-60", 7)} ${lpad("d61-90", 7)} ${lpad("days", 5)}`);
  for (const s of shapes) {
    console.log(
      `  ${pad(s.name, 24)} ${lpad(s.first30 ?? 0, 6)} ${lpad(s.middle30 ?? 0, 7)} ${lpad(s.last30 ?? 0, 7)} ${lpad(s.days_with_sales, 5)}`,
    );
  }

  console.log("\n== Top 5 products by revenue, last 30 days (line revenue = qty x charged - discount) ==");
  const top = await q<Row>(sql`
    SELECT p.name, SUM(l.quantity * l.charged_price - l.discount_amount) AS revenue,
           SUM(l.quantity * l.charged_price - l.discount_amount - l.quantity * l.unit_cost) AS margin
      FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN products p ON p.id = l.product_id
     WHERE s.user_id = ${u} AND ${DAY_IST} >= ${TODAY_IST} - 30
     GROUP BY p.name ORDER BY revenue DESC LIMIT 5`);
  for (const t of top) console.log(`  ${pad(t.name, 24)} ${lpad(rs(t.revenue), 13)}  margin ${lpad(rs(t.margin), 12)}`);

  console.log("\n== Stock on hand ==");
  const [value] = await q<Row>(sql`
    SELECT SUM(quantity_on_hand * average_cost) AS at_cost, SUM(quantity_on_hand * unit_price) AS at_retail,
           SUM(quantity_on_hand) AS units
      FROM products WHERE user_id = ${u} AND is_active`);
  console.log(`  ${value.units} units, worth ${rs(value.at_cost)} at average cost, ${rs(value.at_retail)} at retail`);

  console.log("\n== At or below reorder point ==");
  const low = await q<Row>(sql`
    SELECT name, quantity_on_hand, reorder_point, lead_time_days FROM products
     WHERE user_id = ${u} AND is_active AND quantity_on_hand <= reorder_point ORDER BY name`);
  for (const l of low) {
    console.log(`  ${pad(l.name, 24)} on hand ${lpad(l.quantity_on_hand, 3)}  reorder at ${lpad(l.reorder_point, 3)}  lead ${l.lead_time_days}d`);
  }

  console.log("\n== Weighted average cost at work (receipts for two products) ==");
  for (const sku of ["TEA-CHAI-250", "STP-RICE-1K"]) {
    const rows = await q<Row>(sql`
      SELECT (r.received_at AT TIME ZONE 'Asia/Kolkata')::date AS day, rl.quantity, rl.unit_cost
        FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id JOIN products p ON p.id = rl.product_id
       WHERE p.user_id = ${u} AND p.sku = ${sku} ORDER BY r.received_at`);
    const [p] = await q<Row>(sql`SELECT name, average_cost FROM products WHERE user_id = ${u} AND sku = ${sku}`);
    console.log(
      `  ${p.name}: ${rows.map((r) => `${r.quantity}@${rs(r.unit_cost)}`).join(", ")}  -> average now ${rs(p.average_cost)}`,
    );
  }

  console.log("\n== Promotions ==");
  const promos = await q<Row>(sql`
    SELECT p.name, pr.type, pr.percent, pr.buy_qty, pr.get_qty,
           (pr.starts_at AT TIME ZONE 'Asia/Kolkata')::date AS starts,
           (pr.ends_at AT TIME ZONE 'Asia/Kolkata')::date AS ends,
           COUNT(l.id) AS lines,
           COALESCE(SUM(l.quantity) FILTER (WHERE l.is_free_unit), 0) AS free_units,
           COALESCE(SUM(l.quantity * (l.list_price - l.charged_price)), 0) AS discount_given
      FROM promotions pr JOIN products p ON p.id = pr.product_id
      LEFT JOIN sale_lines l ON l.promotion_id = pr.id
     WHERE pr.user_id = ${u}
     GROUP BY p.name, pr.id ORDER BY pr.starts_at`);
  for (const p of promos) {
    const rule = p.type === "percent_off" ? `${p.percent}% off` : `buy ${p.buy_qty} get ${p.get_qty}`;
    const state =
      new Date(String(p.ends)) < new Date() ? "expired" : new Date(String(p.starts)) > new Date() ? "scheduled" : "live";
    console.log(
      `  ${pad(p.name, 22)} ${pad(rule, 14)} ${String(p.starts).slice(0, 10)} -> ${String(p.ends).slice(0, 10)}  ${pad(state, 9)} ` +
        `${lpad(p.lines, 4)} discounted lines, ${lpad(p.free_units, 3)} free units, ${rs(p.discount_given)} given`,
    );
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
