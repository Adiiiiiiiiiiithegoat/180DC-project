/**
 * Demo seed: one account, ~20 products, 90 days of trading history.
 *
 *   npm run seed                      -> rebuilds the `local` branch and seeds it
 *   npx tsx scripts/seed.ts --env F   -> seeds the (empty) database F points at
 *
 * --reset drops and re-migrates the target database first. Without it the
 * seed refuses to run where the demo account already exists.
 *
 * Every chart, reorder figure and assistant answer is computed from this data,
 * so it is shaped deliberately rather than uniformly random:
 *
 *   - a weekly rhythm (Saturday busiest, Monday quietest) and a shared
 *     day-to-day shock, so neighbouring products move together on a slow day
 *   - Poisson noise per product per day
 *   - one product trending up, one declining to almost nothing, one seasonal
 *     (monsoon umbrellas), one steady high-volume, one dead-stock item, and one
 *     with only 5 days of history (the insufficient-history path in Phase 6)
 *   - receipts at drifting, noisy unit costs, so weighted average cost has
 *     something to average
 *   - three products left below their reorder point on day one
 *   - promotions of both types, plus one expired and one scheduled, with a
 *     sales lift while they run
 *
 * It goes through the SAME service functions the UI uses — receiveGoods and
 * recordSale — rather than inserting rows directly, so every seeded sale has a
 * stamped cost, one movement per line, and a conditional decrement, exactly
 * like a real one. The only difference is the internal `at` option, which
 * back-dates the event; it is not reachable from any request.
 *
 * Deterministic: a fixed-seed PRNG, so every run produces the same shop,
 * shifted to end yesterday.
 */
import { envFile } from "./env";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/db";
import { auth } from "../src/lib/auth";
import {
  createProduct,
  createPromotion,
  receiveGoods,
  recordSale,
  reconcileStock,
} from "../src/lib/services";
import { DEMO } from "./seed-account";



const DAYS = 90;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const IST = 330 * 60_000; // the shop is in India; days and weekdays are IST days

// --- deterministic randomness -------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(180);

/** Knuth's method; fine for the small daily rates used here. */
function poisson(lambda: number): number {
  if (lambda <= 0) return 0;
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

// --- calendar -----------------------------------------------------------------

// UTC instant of today's midnight in IST. Day d = 0..89; day 89 is yesterday,
// so no seeded sale is ever in the future and "today" starts empty.
const todayStart = Math.floor((Date.now() + IST) / DAY) * DAY - IST;
const dayStart = (d: number) => todayStart - (DAYS - d) * DAY;
const weekday = (d: number) => new Date(dayStart(d) + IST).getUTCDay(); // 0 = Sunday

// Saturday is the busiest day, Monday the quietest.
const WEEKLY = [1.25, 0.8, 0.85, 0.9, 0.95, 1.1, 1.35];

// --- the catalogue --------------------------------------------------------------

type Shape = (d: number) => number;
const t = (d: number) => d / (DAYS - 1);
const steady: Shape = () => 1;
const trendingUp: Shape = (d) => 0.12 + 1.5 * t(d) ** 1.6;
const declining: Shape = (d) => Math.max(0.02, (1 - t(d)) ** 2.4);
const monsoon: Shape = (d) => 0.12 + Math.exp(-(((d - 38) / 13) ** 2)); // peaks in July
const newArrival: Shape = (d) => (d >= DAYS - 5 ? 1 : 0);

type Spec = {
  name: string;
  sku: string;
  category: string;
  price: number; // paise
  cost: number; // paise, before drift and noise
  base: number; // units per day at shape 1
  shape: Shape;
  supplier: string;
  lead: number; // days
  caseSize: number;
  /** Left below its reorder point on day one: stock on hand at the end. */
  endBelowReorder?: number;
  /** A one-off opening order instead of the reorder policy (dead stock). */
  openingQty?: number;
};

const SUPPLIERS = {
  tea: "Nilgiri Tea Traders",
  grocer: "Metro Wholesale",
  home: "HomeCare Distributors",
  paper: "Sharma Stationers",
  rain: "Monsoon Mart Supplies",
};

const CATALOGUE: Spec[] = [
  // Tea & Coffee
  { name: "Masala Chai 250g", sku: "TEA-CHAI-250", category: "Tea & Coffee", price: 18000, cost: 12000, base: 14, shape: steady, supplier: SUPPLIERS.tea, lead: 5, caseSize: 12 },
  { name: "Filter Coffee 200g", sku: "COF-FILT-200", category: "Tea & Coffee", price: 24000, cost: 16500, base: 5, shape: steady, supplier: SUPPLIERS.tea, lead: 5, caseSize: 12 },
  { name: "Cold Brew Can 250ml", sku: "COF-COLD-250", category: "Tea & Coffee", price: 12000, cost: 7000, base: 9, shape: trendingUp, supplier: SUPPLIERS.tea, lead: 5, caseSize: 24 },
  { name: "Green Tea 25 bags", sku: "TEA-GRN-25", category: "Tea & Coffee", price: 19900, cost: 13000, base: 2, shape: steady, supplier: SUPPLIERS.tea, lead: 5, caseSize: 6 },
  // Snacks
  { name: "Glucose Biscuits 250g", sku: "SNK-BISC-250", category: "Snacks", price: 4000, cost: 2800, base: 9, shape: steady, supplier: SUPPLIERS.grocer, lead: 3, caseSize: 24 },
  { name: "Salted Peanuts 200g", sku: "SNK-PNUT-200", category: "Snacks", price: 7000, cost: 4500, base: 5, shape: steady, supplier: SUPPLIERS.grocer, lead: 3, caseSize: 12 },
  { name: "Masala Chips 100g", sku: "SNK-CHIP-100", category: "Snacks", price: 3000, cost: 1900, base: 8, shape: steady, supplier: SUPPLIERS.grocer, lead: 3, caseSize: 24 },
  { name: "Protein Bar Choco", sku: "SNK-PBAR-CHO", category: "Snacks", price: 9000, cost: 5500, base: 4, shape: newArrival, supplier: SUPPLIERS.grocer, lead: 3, caseSize: 12 },
  // Staples
  { name: "Basmati Rice 1kg", sku: "STP-RICE-1K", category: "Staples", price: 16000, cost: 11800, base: 4, shape: steady, supplier: SUPPLIERS.grocer, lead: 3, caseSize: 10, endBelowReorder: 5 },
  { name: "Toor Dal 1kg", sku: "STP-DAL-1K", category: "Staples", price: 17500, cost: 13200, base: 3, shape: steady, supplier: SUPPLIERS.grocer, lead: 3, caseSize: 10 },
  { name: "Sunflower Oil 1L", sku: "STP-OIL-1L", category: "Staples", price: 18500, cost: 15000, base: 3, shape: steady, supplier: SUPPLIERS.grocer, lead: 3, caseSize: 12 },
  // Household
  { name: "Dish Soap 500ml", sku: "HH-DISH-500", category: "Household", price: 11000, cost: 7200, base: 2.5, shape: steady, supplier: SUPPLIERS.home, lead: 4, caseSize: 12, endBelowReorder: 3 },
  { name: "Detergent Powder 1kg", sku: "HH-DET-1K", category: "Household", price: 14000, cost: 9800, base: 2.5, shape: steady, supplier: SUPPLIERS.home, lead: 4, caseSize: 10 },
  { name: "Mosquito Coils (10)", sku: "HH-COIL-10", category: "Household", price: 6000, cost: 3800, base: 3, shape: steady, supplier: SUPPLIERS.home, lead: 4, caseSize: 24 },
  { name: "Scented Candle Jar", sku: "HH-CNDL-JAR", category: "Household", price: 35000, cost: 21000, base: 0.12, shape: steady, supplier: SUPPLIERS.home, lead: 4, caseSize: 6, openingQty: 24 },
  // Seasonal
  { name: "Compact Umbrella", sku: "SEA-UMB-CMP", category: "Seasonal", price: 45000, cost: 29000, base: 6, shape: monsoon, supplier: SUPPLIERS.rain, lead: 10, caseSize: 10 },
  // Stationery
  { name: "A5 Notebook (Classic)", sku: "STN-NB-A5", category: "Stationery", price: 6000, cost: 3500, base: 9, shape: declining, supplier: SUPPLIERS.paper, lead: 7, caseSize: 20 },
  { name: "Ballpoint Pens (10)", sku: "STN-PEN-10", category: "Stationery", price: 10000, cost: 6200, base: 3, shape: steady, supplier: SUPPLIERS.paper, lead: 7, caseSize: 10, endBelowReorder: 4 },
  { name: "Gel Pen Blue", sku: "STN-GEL-BLU", category: "Stationery", price: 2500, cost: 1400, base: 4, shape: steady, supplier: SUPPLIERS.paper, lead: 7, caseSize: 20 },
  { name: "Sticky Notes Pad", sku: "STN-STKY-PAD", category: "Stationery", price: 4500, cost: 2600, base: 1.5, shape: steady, supplier: SUPPLIERS.paper, lead: 7, caseSize: 12 },
];

// Promotion windows, in day indices. The sales lift applies while they run.
const PROMOS = [
  { sku: "SNK-BISC-250", type: "buy_x_get_y" as const, buyQty: 2, getQty: 1, from: 50, to: DAYS + 45, lift: 1.3 },
  { sku: "COF-FILT-200", type: "percent_off" as const, percent: 10, from: 60, to: DAYS + 30, lift: 1.15 },
  { sku: "STP-DAL-1K", type: "percent_off" as const, percent: 15, from: 20, to: 34, lift: 1.2 }, // expired
  { sku: "TEA-GRN-25", type: "percent_off" as const, percent: 20, from: DAYS + 5, to: DAYS + 20, lift: 1 }, // scheduled
];
const promoFor = (sku: string, d: number) =>
  PROMOS.find((p) => p.sku === sku && d >= p.from && d <= p.to);

// --- plan the whole history in memory first -------------------------------------

const LOW_WINDOW = 12; // below-reorder products get no deliveries in the last 12 days

const dayShock = Array.from({ length: DAYS }, () => 1 + 0.15 * (rand() * 2 - 1));

const demand = CATALOGUE.map((p) =>
  Array.from({ length: DAYS }, (_, d) =>
    poisson(p.base * p.shape(d) * WEEKLY[weekday(d)] * dayShock[d] * (promoFor(p.sku, d)?.lift ?? 1)),
  ),
);

/** Reorder point: lead-time demand over the last 30 days, plus 20%. */
const reorderPoints = CATALOGUE.map((p) => {
  let recent = 0;
  for (let d = DAYS - 30; d < DAYS; d++) recent += p.base * p.shape(d);
  return Math.max(2, Math.ceil((recent / 30) * p.lead * 1.2));
});

type PlannedReceipt = { day: number; product: number; qty: number; unitCost: number };
const planned: PlannedReceipt[] = [];

function unitCostOn(p: Spec, d: number) {
  // ~8% cost inflation across the quarter, +/-5% delivery-to-delivery noise,
  // rounded to 50 paise the way a supplier invoice would be.
  const raw = p.cost * (1 + 0.08 * t(d)) * (1 + (rand() - 0.5) * 0.1);
  return Math.round(raw / 50) * 50;
}

const finalStock = CATALOGUE.map((p, i) => {
  const rp = reorderPoints[i];
  const dem = demand[i];
  const windowStart = DAYS - LOW_WINDOW;
  let onHand = 0;
  for (let d = 0; d < DAYS; d++) {
    if (p.shape(d) === 0 && onHand === 0) continue; // not stocked yet
    const receive = (qty: number) => {
      planned.push({ day: d, product: i, qty, unitCost: unitCostOn(p, d) });
      onHand += qty;
    };

    if (p.openingQty !== undefined) {
      if (d === 0) receive(p.openingQty);
    } else if (p.endBelowReorder !== undefined && d >= windowStart) {
      if (d === windowStart) {
        // Stock exactly enough to cover the window and finish at the target.
        const needed = p.endBelowReorder + dem.slice(d).reduce((s, n) => s + n, 0);
        if (onHand < needed) receive(needed - onHand);
        // Too much already on the shelf: it sells, spread over the window.
        for (let extra = onHand - needed; extra > 0; extra--) {
          dem[windowStart + Math.floor(rand() * LOW_WINDOW)]++;
        }
      }
    } else if (onHand < dem[d] + rp) {
      // Order when today's sales would take stock below the reorder point:
      // two weeks of expected demand on top of the shortfall, in whole cases.
      let twoWeeks = 0;
      for (let k = d; k < d + 14; k++) twoWeeks += p.base * p.shape(Math.min(k, DAYS - 1));
      const want = Math.ceil(twoWeeks) + dem[d] + rp - onHand;
      receive(Math.ceil(want / p.caseSize) * p.caseSize);
    }

    onHand -= dem[d];
    if (onHand < 0) throw new Error(`plan bug: ${p.name} negative on day ${d}`);
  }
  return onHand;
});

// --- execute ----------------------------------------------------------------------

/**
 * Runs `fn` over `items` with at most `workers` in flight, starting the next
 * item as soon as any finishes. (Fixed batches would wait for the slowest sale
 * in each batch — always the one queued behind a busy product's row lock.)
 */
async function pooled<T>(items: T[], workers: number, fn: (item: T) => Promise<unknown>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

const WORKERS = Number(process.env.PG_POOL_MAX ?? 10);

async function main() {
  const host = new URL(process.env.DATABASE_URL!).host;
  console.log(`Seeding ${host} (env: ${envFile})`);

  // No DELETE, not even of a whole demo account: sale_lines and receipt_lines
  // reference products without cascading (DESIGN section 6), so a user who has
  // traded cannot be deleted, and removing ledger rows to get round that is
  // exactly what the append-only rule forbids. Re-seeding therefore means
  // rebuilding the whole database from migrations, and only on request.
  if (process.argv.includes("--reset")) {
    console.log("--reset: dropping and re-migrating this database");
    await pool.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      CREATE SCHEMA public;
    `);
    await migrate(db, { migrationsFolder: "./drizzle" });
  }
  const [existing] = (await db.execute(sql`SELECT 1 FROM users WHERE email = ${DEMO.email}`)).rows;
  if (existing) {
    throw new Error(`${DEMO.email} already exists here; pass --reset to rebuild this database first`);
  }
  const { user } = await auth.api.signUpEmail({ body: DEMO });
  const userId = user.id;
  console.log(`Demo account ${DEMO.email} / ${DEMO.password}`);

  const productIds: string[] = [];
  for (const [i, p] of CATALOGUE.entries()) {
    const row = await createProduct(userId, {
      name: p.name,
      sku: p.sku,
      category: p.category,
      unitPrice: p.price,
      reorderPoint: reorderPoints[i],
      leadTimeDays: p.lead,
    });
    productIds.push(row.id);
  }

  for (const promo of PROMOS) {
    const i = CATALOGUE.findIndex((p) => p.sku === promo.sku);
    await createPromotion(userId, {
      productId: productIds[i],
      type: promo.type,
      percent: promo.type === "percent_off" ? promo.percent : null,
      buyQty: promo.type === "buy_x_get_y" ? promo.buyQty : null,
      getQty: promo.type === "buy_x_get_y" ? promo.getQty : null,
      priority: 0,
      startsAt: new Date(dayStart(promo.from)),
      endsAt: new Date(dayStart(promo.to) + DAY - 1),
    });
  }

  const started = performance.now();
  let saleCount = 0;
  let receiptCount = 0;

  for (let d = 0; d < DAYS; d++) {
    // Morning deliveries, one receipt per supplier.
    const today = planned.filter((r) => r.day === d);
    const bySupplier = new Map<string, PlannedReceipt[]>();
    for (const r of today) {
      const s = CATALOGUE[r.product].supplier;
      bySupplier.set(s, [...(bySupplier.get(s) ?? []), r]);
    }
    for (const [supplier, lines] of bySupplier) {
      const at = new Date(dayStart(d) + 8 * HOUR);
      await receiveGoods(
        userId,
        {
          supplierName: supplier,
          reference: `DN-${String(1000 + receiptCount).padStart(5, "0")}`,
          receivedAt: at,
          lines: lines.map((l) => ({
            productId: productIds[l.product],
            quantity: l.qty,
            unitCost: l.unitCost,
          })),
        },
        { at },
      );
      receiptCount++;
    }

    // The day's demand, cut into what individual customers carried to the
    // till. Buy-2-get-1 is bought in threes while it runs, because that is
    // what a promotion like that does to baskets.
    const chunks: { product: number; qty: number }[] = [];
    CATALOGUE.forEach((p, i) => {
      let n = demand[i][d];
      if (promoFor(p.sku, d)?.type === "buy_x_get_y") {
        while (n >= 3 && rand() < 0.8) {
          chunks.push({ product: i, qty: 3 });
          n -= 3;
        }
      }
      while (n > 0) {
        const qty = Math.min(n, rand() < 0.25 ? 2 : 1);
        chunks.push({ product: i, qty });
        n -= qty;
      }
    });
    const units = chunks.reduce((s, c) => s + c.qty, 0);
    const basketCount = Math.max(3, Math.round(units / 3.5));
    const baskets = Array.from({ length: basketCount }, () => new Map<number, number>());
    for (const c of chunks) {
      const b = baskets[Math.floor(rand() * basketCount)];
      b.set(c.product, (b.get(c.product) ?? 0) + c.qty);
    }
    const sales = baskets
      .filter((b) => b.size > 0)
      .map((b, n) => ({
        key: `seed-${d}-${n}`,
        at: new Date(dayStart(d) + 9 * HOUR + Math.floor(rand() * 12 * HOUR)),
        lines: [...b].map(([product, quantity]) => ({ productId: productIds[product], quantity })),
      }));

    await pooled(sales, WORKERS, (s) =>
      recordSale(userId, { idempotencyKey: s.key, lines: s.lines }, { at: s.at }),
    );
    saleCount += sales.length;

    if (d % 10 === 9 || d === DAYS - 1) {
      const secs = ((performance.now() - started) / 1000).toFixed(0);
      console.log(`  day ${d + 1}/${DAYS}: ${saleCount} sales, ${receiptCount} receipts (${secs}s)`);
    }
  }

  // The seed is only trustworthy if it obeys the same invariants as the app.
  const drift = await reconcileStock(userId);
  if (drift.length) throw new Error(`ledger drift after seeding: ${JSON.stringify(drift)}`);
  const onHand = await db.execute<{ sku: string; quantity_on_hand: number; reorder_point: number }>(
    sql`SELECT sku, quantity_on_hand, reorder_point FROM products WHERE user_id = ${userId}`,
  );
  for (const row of onHand.rows) {
    const i = CATALOGUE.findIndex((p) => p.sku === row.sku);
    if (row.quantity_on_hand !== finalStock[i]) {
      throw new Error(`${row.sku}: database says ${row.quantity_on_hand}, plan says ${finalStock[i]}`);
    }
  }
  const below = onHand.rows.filter((r) => r.quantity_on_hand < r.reorder_point);
  console.log(
    `Done: ${CATALOGUE.length} products, ${receiptCount} receipts, ${saleCount} sales. ` +
      `Ledger reconciles. Below reorder point: ${below.map((r) => `${r.sku} (${r.quantity_on_hand}/${r.reorder_point})`).join(", ")}`,
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
