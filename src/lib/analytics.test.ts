/**
 * Phase 6 oracle test. The expected values below are not whatever these
 * functions return: they are copied from `npm run seed:report`, which
 * computes them with its own, independent SQL. The functions must reproduce
 * them exactly, to the paise.
 *
 * Read-only, against the seeded Neon `local` branch (.env.development.local).
 *
 * `now` is fixed here, in the test, never in the functions. The seed ends the
 * day before it is run, and the local branch was seeded — and the report
 * taken — on 2026-09-10 IST. If `npm run seed` rebuilds local on another day,
 * the history shifts and the weekday rhythm with it: re-run seed:report and
 * update NOW and the figures together. The first test fails loudly if that
 * has happened, rather than every other test failing mysteriously.
 */
import "../../scripts/use-local-env";
import "../../scripts/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import {
  findProduct,
  getInventoryStatus,
  getProductPerformance,
  getReorderSuggestions,
  getSalesSummary,
  getSalesTimeSeries,
  getStockHistory,
} from "./analytics";
import { ServiceError } from "./services";

const NOW = new Date("2026-09-10T12:00:00+05:30");
let u: string;

before(async () => {
  const { rows } = await db.execute<{ id: string; last: string }>(sql`
    SELECT u.id, (MAX(s.sold_at) AT TIME ZONE 'Asia/Kolkata')::date::text AS last
      FROM users u JOIN sales s ON s.user_id = u.id
     WHERE u.email = 'demo@example.com' GROUP BY u.id`);
  assert.ok(rows[0], "no demo account on the local branch: run npm run seed");
  assert.equal(
    rows[0].last,
    "2026-09-09",
    "local was reseeded on a different day: re-run npm run seed:report and update NOW and the figures",
  );
  u = rows[0].id;
});

after(() => pool.end());

test("getSalesSummary: last 30 days vs the 30 before, exactly as seed-report", async () => {
  const s = await getSalesSummary(u, { days: 30 }, NOW);
  assert.ok("previousPeriod" in s);

  assert.deepEqual(s.period, { from: "2026-08-11", to: "2026-09-09", days: 30 });
  // seed-report: last 30  revenue ₹3,14,159.00  COGS ₹2,27,944.88  gross margin ₹86,214.12 (27.4%)
  //              730 sales, 2720 units, avg basket ₹430.35
  assert.equal(s.revenuePaise, 31415900);
  assert.equal(s.costOfGoodsPaise, 22794488);
  assert.equal(s.grossMarginPaise, 8621412);
  assert.equal(s.grossMarginPct, 27.4);
  assert.equal(s.transactions, 730);
  assert.equal(s.units, 2720);
  assert.equal(s.averageBasketPaise, 43035);

  // seed-report: prior 30  revenue ₹3,39,808.75  COGS ₹2,36,039.64  gross margin ₹1,03,769.11 (30.5%)
  //              696 sales, 2601 units, avg basket ₹488.23
  const p = s.previousPeriod;
  assert.deepEqual(p.period, { from: "2026-07-12", to: "2026-08-10" });
  assert.equal(p.revenuePaise, 33980875);
  assert.equal(p.costOfGoodsPaise, 23603964);
  assert.equal(p.grossMarginPaise, 10376911);
  assert.equal(p.grossMarginPct, 30.5);
  assert.equal(p.transactions, 696);
  assert.equal(p.units, 2601);
  assert.equal(p.averageBasketPaise, 48823);

  // The deltas come from SQL; the oracle's own difference checks them.
  assert.equal(s.change.revenuePaise, 31415900 - 33980875);
  assert.equal(s.change.grossMarginPaise, 8621412 - 10376911);
  assert.equal(s.change.transactions, 730 - 696);
  assert.equal(s.change.units, 2720 - 2601);
  assert.equal(s.change.revenuePct, -7.5);
});

test("getSalesTimeSeries: complete weeks only, each exactly as seed-report", async () => {
  const { points } = await getSalesTimeSeries(u, { granularity: "week", days: 90 }, NOW);
  // seed-report's weekly table, minus its first week (2026-06-08: trading
  // began Friday 12 June) and its last (2026-09-07: Mon-Wed only). Both are
  // partial and would plot as false dips.
  assert.deepEqual(
    points.map((w) => [w.start, w.revenuePaise]),
    [
      ["2026-06-15", 6424300],
      ["2026-06-22", 6723800],
      ["2026-06-29", 6973600],
      ["2026-07-06", 7290875],
      ["2026-07-13", 7663575],
      ["2026-07-20", 8902800],
      ["2026-07-27", 8022400],
      ["2026-08-03", 7030800],
      ["2026-08-10", 7420500],
      ["2026-08-17", 6579800],
      ["2026-08-24", 7759800],
      ["2026-08-31", 7848700],
    ],
  );
  assert.ok(points.every((w) => w.end === isoPlusDays(w.start, 6)), "every week is Monday to Sunday");
});

test("getSalesTimeSeries: 30 daily points that add up to the 30-day revenue", async () => {
  const { points } = await getSalesTimeSeries(u, { granularity: "day", days: 30 }, NOW);
  assert.equal(points.length, 30);
  assert.equal(points[0].start, "2026-08-11");
  assert.equal(points.at(-1)!.start, "2026-09-09", "yesterday is the last day; today is never included");
  assert.equal(points.reduce((sum, d) => sum + d.revenuePaise, 0), 31415900);
});

// seed-report "Product shapes": units in the first, middle and last 30 days.
const SHAPES: Record<string, [number, number, number]> = {
  "A5 Notebook (Classic)": [212, 48, 8],
  "Ballpoint Pens (10)": [109, 83, 101],
  "Basmati Rice 1kg": [128, 133, 134],
  "Cold Brew Can 250ml": [59, 160, 345],
  "Compact Umbrella": [47, 129, 24],
  "Detergent Powder 1kg": [68, 75, 90],
  "Dish Soap 500ml": [78, 75, 83],
  "Filter Coffee 200g": [161, 153, 178],
  "Gel Pen Blue": [135, 143, 119],
  "Glucose Biscuits 250g": [284, 313, 398],
  "Green Tea 25 bags": [58, 60, 59],
  "Masala Chai 250g": [444, 462, 443],
  "Masala Chips 100g": [245, 250, 239],
  "Mosquito Coils (10)": [87, 88, 87],
  "Protein Bar Choco": [0, 0, 22],
  "Salted Peanuts 200g": [160, 178, 152],
  "Scented Candle Jar": [1, 7, 3],
  "Sticky Notes Pad": [34, 51, 45],
  "Sunflower Oil 1L": [82, 108, 93],
  "Toor Dal 1kg": [111, 85, 97],
};

test("getProductPerformance: units per product, this window and the one before", async () => {
  const last = await getProductPerformance(u, { days: 30 }, NOW);
  assert.equal(last.products.length, 20, "every product, including ones that sold nothing");
  for (const p of last.products) {
    const [, middle, final] = SHAPES[p.name];
    assert.equal(p.units, final, `${p.name} units, last 30 days`);
    assert.equal(p.previousUnits, middle, `${p.name} units, the 30 before`);
  }

  // The oldest block: Protein Bar had not arrived yet and must still appear, at zero.
  const oldest = await getProductPerformance(u, { days: 30, endDate: "2026-07-11" }, NOW);
  assert.deepEqual(oldest.period, { from: "2026-06-12", to: "2026-07-11", days: 30 });
  for (const p of oldest.products) assert.equal(p.units, SHAPES[p.name][0], `${p.name} units, first 30 days`);
  assert.equal(oldest.products.find((p) => p.name === "Protein Bar Choco")!.revenuePaise, 0);
});

test("getProductPerformance: top 5 by revenue and their margins, exactly as seed-report", async () => {
  const top = await getProductPerformance(u, { days: 30, sortBy: "revenue", limit: 5 }, NOW);
  assert.deepEqual(
    top.products.map((p) => [p.name, p.revenuePaise, p.grossMarginPaise]),
    [
      ["Masala Chai 250g", 7974000, 2428650],
      ["Cold Brew Can 250ml", 4140000, 1665345],
      ["Filter Coffee 200g", 3844800, 702856],
      ["Basmati Rice 1kg", 2144000, 437466],
      ["Sunflower Oil 1L", 1720500, 269991],
    ],
  );
});

test("getProductPerformance: what the promotions gave away, exactly as seed-report", async () => {
  // All 90 days, so every promotion's whole run is inside the window.
  const all = await getProductPerformance(u, { days: 90 }, NOW);
  const by = (name: string) => all.products.find((p) => p.name === name)!;
  // seed-report "Promotions": buy 2 get 1 on biscuits, 96 free units, ₹3,840.00;
  // 10% off filter coffee ₹4,272.00; 15% off toor dal (expired) ₹1,417.50.
  assert.equal(by("Glucose Biscuits 250g").freeUnits, 96);
  assert.equal(by("Glucose Biscuits 250g").discountsGivenPaise, 384000);
  assert.equal(by("Filter Coffee 200g").discountsGivenPaise, 427200);
  assert.equal(by("Toor Dal 1kg").discountsGivenPaise, 141750);
  // Live promotions are named; the expired and the scheduled ones are not.
  assert.equal(by("Glucose Biscuits 250g").livePromotion, "buy 2 get 1 free, 2026-08-01 to 2026-10-25");
  assert.equal(by("Filter Coffee 200g").livePromotion, "10% off, 2026-08-11 to 2026-10-10");
  assert.equal(by("Toor Dal 1kg").livePromotion, null);
  assert.equal(by("Green Tea 25 bags").livePromotion, null);
});

test("getInventoryStatus: the three below reorder point, and stock value, exactly as seed-report", async () => {
  const low = await getInventoryStatus(u, { filter: "low" });
  assert.deepEqual(
    low.items.map((p) => [p.name, p.onHand, p.reorderPoint, p.leadTimeDays]).sort(),
    [
      ["Ballpoint Pens (10)", 4, 26, 7],
      ["Basmati Rice 1kg", 5, 15, 3],
      ["Dish Soap 500ml", 3, 12, 4],
    ],
  );
  // seed-report: 976 units, worth ₹89,977.33 at average cost, ₹1,30,526.00 at retail
  assert.equal(low.totals.unitsOnHand, 976);
  assert.equal(low.totals.stockValueAtCostPaise, 8997733);
  assert.equal(low.totals.stockValueAtRetailPaise, 13052600);

  // seed-report: weighted average cost now ₹123.86 (chai), ₹127.45 (rice)
  const all = await getInventoryStatus(u);
  assert.equal(all.items.find((p) => p.sku === "TEA-CHAI-250")!.averageCostPaise, 12386);
  assert.equal(all.items.find((p) => p.sku === "STP-RICE-1K")!.averageCostPaise, 12745);
});

test("getReorderSuggestions: Protein Bar has 5 days of history and gets no number", async () => {
  const { products, method } = await getReorderSuggestions(u, NOW);
  assert.equal(method.k, 1.65);

  const bar = products.find((p) => p.name === "Protein Bar Choco")!;
  assert.equal(bar.status, "insufficient_history");
  assert.ok(!("suggestedReorderPoint" in bar), "no number at all, not a zero");
  assert.equal(bar.historyDays, 5);
  assert.equal(products.filter((p) => p.status === "insufficient_history").length, 1);

  // The inputs come back with the output. Masala Chai sold 443 in the last 30
  // days (seed-report), so its mean is 443 / 30.
  const chai = products.find((p) => p.sku === "TEA-CHAI-250")!;
  assert.ok(chai.inputs, "a number comes back with its inputs");
  assert.equal(chai.inputs.unitsSoldInWindow, 443);
  assert.equal(chai.inputs.meanDailyUnits, 14.77);
  assert.equal(chai.inputs.daysInWindow, 30);

  // All three products under their reorder point come back as reorder_now.
  for (const sku of ["STN-PEN-10", "STP-RICE-1K", "HH-DISH-500"]) {
    assert.equal(products.find((p) => p.sku === sku)!.status, "reorder_now", sku);
  }

  // The buffer scales with √(lead time). Recomputed here from the returned
  // (2dp-rounded) inputs, so allow the rounding to move the ceiling by one;
  // the old k x std dev buffer is several units short for a 7-day lead time.
  for (const p of products) {
    if (!p.inputs) continue;
    const { meanDailyUnits: m, stdDevDailyUnits: sd, leadTimeDays: lt } = p.inputs;
    const expected = Math.ceil(m! * lt + method.k * sd! * Math.sqrt(lt));
    assert.ok(Math.abs(p.suggestedReorderPoint! - expected) <= 1, `${p.name}: ${p.suggestedReorderPoint} vs ${expected}`);
  }
});

test("includeToday: the window ends now, and the previous one is cut at the same time of day", async () => {
  // Local's last sale is 9 Sep, so at noon on 10 Sep "today so far" is empty
  // and two days to now is exactly the whole of 9 Sep.
  const today = await getSalesSummary(u, { days: 1, includeToday: true }, NOW);
  assert.ok("previousPeriod" in today);
  assert.deepEqual(today.period, { from: "2026-09-10", to: "2026-09-10", days: 1 });
  assert.equal(today.revenuePaise, 0);
  assert.match(today.partial!, /up to 12:00 IST/);
  assert.deepEqual(today.previousPeriod.period, { from: "2026-09-09", to: "2026-09-09" });

  // Oracle: yesterday until noon, by independent SQL.
  const [{ revenue }] = (await db.execute<{ revenue: number }>(sql`
    SELECT COALESCE(SUM(total), 0)::bigint AS revenue FROM sales
     WHERE user_id = ${u} AND sold_at >= '2026-09-09T00:00:00+05:30' AND sold_at < '2026-09-09T12:00:00+05:30'`)).rows;
  assert.equal(today.previousPeriod.revenuePaise, revenue);

  const twoDays = await getSalesSummary(u, { days: 2, includeToday: true }, NOW);
  const ninth = await getSalesSummary(u, { days: 1, endDate: "2026-09-09" }, NOW);
  assert.equal(twoDays.revenuePaise, ninth.revenuePaise);

  // The complete-days default is untouched by all this.
  assert.equal((await getSalesSummary(u, { days: 30 }, NOW)).revenuePaise, 31415900);
  assert.equal((await getSalesSummary(u, { days: 30 }, NOW)).partial, undefined);
});

test("getStockHistory: the ledger's last closing balance is what is on the shelf", async () => {
  const { candidates } = await findProduct(u, { query: "masala chai" });
  assert.equal(candidates[0].sku, "TEA-CHAI-250");
  // The ledger runs through today (unlike the sales windows), so 31 days back
  // from 10 Sep covers seed-report's 11 Aug - 9 Sep plus an empty today.
  const h = await getStockHistory(u, { productId: candidates[0].id, days: 31 }, NOW);
  assert.equal(h.from, "2026-08-11");
  assert.equal(h.days.at(-1)!.closing, h.product.onHandNow);
  assert.equal(h.days.reduce((s, d) => s + d.sold, 0), 443, "30 days of chai sales, as seed-report");
});

test("another account sees none of it", async () => {
  const stranger = randomUUID();
  const s = await getSalesSummary(stranger, { days: 90 }, NOW);
  assert.equal(s.revenuePaise, 0);
  assert.equal(s.transactions, 0);
  assert.equal((await getInventoryStatus(stranger)).items.length, 0);
  assert.equal((await getProductPerformance(stranger, {}, NOW)).products.length, 0);
  assert.equal((await findProduct(stranger, { query: "chai" })).candidates.length, 0);
  assert.equal((await getReorderSuggestions(stranger, NOW)).products.length, 0);

  // A real product id from the demo account, asked for by someone else.
  const { candidates } = await findProduct(u, { query: "chai" });
  await assert.rejects(
    getStockHistory(stranger, { productId: candidates[0].id }, NOW),
    (e) => e instanceof ServiceError && e.code === "not_found",
  );
});

function isoPlusDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
