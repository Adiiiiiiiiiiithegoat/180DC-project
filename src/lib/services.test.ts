/**
 * Phase 3 verification. Integration tests against a real Postgres — the Neon
 * `dev` branch, via .env.test. These are not unit tests with a fake database:
 * every guarantee being checked here (row locks, conditional UPDATE, unique
 * violations, rollback) is a property of Postgres, and a mock would assert
 * nothing.
 *
 * The env import must come first: ../db builds its Pool from DATABASE_URL at
 * module load.
 */
import "../../scripts/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../db";
import { users } from "../db/auth-schema";
import { products, promotions, saleLines, sales, stockMovements } from "../db/schema";
import {
  ServiceError,
  adjustStock,
  receiveGoods,
  recordSale,
  reconcileStock,
} from "./services";

const createdUsers: string[] = [];
let seq = 0;

async function newUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ name: label, email: `${label}-${Date.now()}-${seq++}@test.local` })
    .returning();
  createdUsers.push(u.id);
  return u.id;
}

async function newProduct(
  userId: string,
  over: Partial<typeof products.$inferInsert> = {},
) {
  const [p] = await db
    .insert(products)
    .values({
      userId,
      name: "Blue Mug",
      sku: `SKU-${Date.now()}-${seq++}`,
      unitPrice: 25000,
      ...over,
    })
    .returning();
  return p;
}

const reload = async (id: string) =>
  (await db.select().from(products).where(eq(products.id, id)))[0];

const movementsFor = async (productId: string) =>
  db.select().from(stockMovements).where(eq(stockMovements.productId, productId));

before(async () => {
  // Same reset as Phase 1: the drizzle schema holds the migration journal, so
  // dropping only `public` would leave migrate() believing it had nothing to do.
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public;
  `);
  await migrate(db, { migrationsFolder: "./drizzle" });
});

after(async () => {
  await pool.end();
});

test("1. a sale of 3 units decrements stock by exactly 3, as one line and one movement of -3", async () => {
  const userId = await newUser("t1");
  const product = await newProduct(userId);
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 10, unitCost: 8000 }],
  });

  const before = await reload(product.id);
  assert.equal(before.quantityOnHand, 10);

  const sale = await recordSale(userId, {
    idempotencyKey: "t1-sale",
    lines: [{ productId: product.id, quantity: 3 }],
  });

  const after = await reload(product.id);
  assert.equal(after.quantityOnHand, 7, "10 - 3");
  assert.equal(before.quantityOnHand - after.quantityOnHand, 3, "decremented by exactly 3");

  const moves = await movementsFor(product.id);
  const saleMoves = moves.filter((m) => m.reason === "sale");
  assert.equal(saleMoves.length, 1, "one movement per line, not one per unit");
  assert.deepEqual(
    saleMoves.map((m) => m.quantity),
    [-3],
    "the movement carries the line's signed quantity",
  );

  const lines = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.id));
  assert.equal(lines.length, 1, "three identical units are one line");
  assert.equal(lines[0].quantity, 3, "the line carries a real quantity");
  assert.ok(
    lines.every((l) => l.unitCost === 8000),
    "each line stamps the average cost at the moment of sale",
  );
  assert.equal(sale.costTotal, 3 * 8000, "cost of goods counts every unit, not every line");
});

test("1b. a BOGO sale writes two lines and two movements, and every unit moves", async () => {
  const userId = await newUser("t1b");
  const product = await newProduct(userId, { unitPrice: 25000 });
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 10, unitCost: 8000 }],
  });

  await db.insert(promotions).values({
    userId,
    productId: product.id,
    type: "buy_x_get_y",
    buyQty: 2,
    getQty: 1,
    priority: 0,
    startsAt: new Date(Date.now() - 86_400_000),
    endsAt: new Date(Date.now() + 86_400_000),
  });

  // DESIGN section 4's worked example: 3 mugs, list 250, average cost 80.
  const sale = await recordSale(userId, {
    idempotencyKey: "t1b-bogo",
    lines: [{ productId: product.id, quantity: 3 }],
  });

  const lines = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.id));
  assert.equal(lines.length, 2, "two lines: quantity 2 at 250, quantity 1 at 0");
  assert.deepEqual(
    lines.map((l) => [l.quantity, l.chargedPrice, l.isFreeUnit]).sort(),
    [[1, 0, true], [2, 25000, false]].sort(),
  );

  const saleMoves = (await movementsFor(product.id)).filter((m) => m.reason === "sale");
  assert.equal(saleMoves.length, 2, "one movement per line, free-unit line included");
  assert.deepEqual(
    saleMoves.map((m) => m.quantity).sort((a, b) => a - b),
    [-2, -1],
    "movements of -2 and -1: three units accounted for",
  );

  const after = await reload(product.id);
  assert.equal(after.quantityOnHand, 7, "all three mugs left the shelf, not two");

  // Revenue 500, cost 240, margin 260 — the free unit is zero revenue but full cost.
  assert.equal(sale.total, 50000, "customer pays 500 rupees");
  assert.equal(sale.costTotal, 3 * 8000, "cost counts all three units");
  console.log(
    `      BOGO: ${lines.length} lines, ${saleMoves.length} movements, ` +
      `revenue ${sale.total} paise, cost ${sale.costTotal} paise, ` +
      `margin ${sale.total - sale.costTotal} paise`,
  );
});

test("2. a sale of 5 when 3 are in stock fails and writes NOTHING", async () => {
  const userId = await newUser("t2");
  const product = await newProduct(userId);
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 3, unitCost: 8000 }],
  });

  const salesBefore = await db.select().from(sales).where(eq(sales.userId, userId));
  assert.equal(salesBefore.length, 0);

  await assert.rejects(
    () =>
      recordSale(userId, {
        idempotencyKey: "t2-sale",
        lines: [{ productId: product.id, quantity: 5 }],
      }),
    (e: unknown) =>
      e instanceof ServiceError && e.code === "insufficient_stock",
    "must fail with insufficient_stock",
  );

  // All four assertions the phase asks for, after the failure.
  const salesAfter = await db.select().from(sales).where(eq(sales.userId, userId));
  assert.equal(salesAfter.length, 0, "no sale was written");

  const linesAfter = await db
    .select()
    .from(saleLines)
    .where(eq(saleLines.productId, product.id));
  assert.equal(linesAfter.length, 0, "no sale lines were written");

  const saleMoves = (await movementsFor(product.id)).filter((m) => m.reason === "sale");
  assert.equal(saleMoves.length, 0, "no stock movements were written");

  const after = await reload(product.id);
  assert.equal(after.quantityOnHand, 3, "stock is unchanged");
});

test("3. two genuinely concurrent sales for the last unit: exactly one wins", async () => {
  const userId = await newUser("t3");
  const product = await newProduct(userId);
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 1, unitCost: 8000 }],
  });

  async function timed(key: string) {
    const start = performance.now();
    try {
      const value = await recordSale(userId, {
        idempotencyKey: key,
        lines: [{ productId: product.id, quantity: 1 }],
      });
      return { ok: true as const, value, start, end: performance.now() };
    } catch (error) {
      return { ok: false as const, error, start, end: performance.now() };
    }
  }

  // Both promises are constructed before either is awaited, so the two
  // transactions are genuinely in flight at the same time.
  const [a, b] = await Promise.all([timed("t3-a"), timed("t3-b")]);

  // Proof they actually overlapped rather than running one after the other:
  // each call started before the other had finished.
  const overlapped = a.start < b.end && b.start < a.end;
  console.log(
    `      call A ${a.start.toFixed(1)}ms -> ${a.end.toFixed(1)}ms | ` +
      `call B ${b.start.toFixed(1)}ms -> ${b.end.toFixed(1)}ms | overlapped=${overlapped}`,
  );
  assert.ok(overlapped, "the two calls must have been in flight simultaneously");

  const winners = [a, b].filter((r) => r.ok);
  const losers = [a, b].filter((r) => !r.ok);
  assert.equal(winners.length, 1, "exactly one sale succeeds");
  assert.equal(losers.length, 1, "exactly one sale fails");

  const loser = losers[0] as Extract<typeof a, { ok: false }>;
  assert.ok(
    loser.error instanceof ServiceError && loser.error.code === "insufficient_stock",
    `the loser must lose on stock, not on some unrelated error: ${loser.error}`,
  );

  const after = await reload(product.id);
  assert.equal(after.quantityOnHand, 0, "final stock is 0, not -1");

  const saleMoves = (await movementsFor(product.id)).filter((m) => m.reason === "sale");
  assert.equal(saleMoves.length, 1, "only the winning sale left movements behind");
});

test("3b. concurrent sales locking two products in opposite orders both succeed (no deadlock)", async () => {
  // Sale X is [A, B], sale Y is [B, A]. If each takes row locks in basket order,
  // X holds A and waits for B while Y holds B and waits for A: Postgres detects
  // the cycle and kills one with 40P01, and a perfectly valid sale fails. Locks
  // must be taken in one global order. Plenty of stock, so a failure here can
  // only be a locking failure, never a stockout.
  const userId = await newUser("t3b");
  const a = await newProduct(userId);
  const b = await newProduct(userId);
  await receiveGoods(userId, {
    lines: [
      { productId: a.id, quantity: 50, unitCost: 8000 },
      { productId: b.id, quantity: 50, unitCost: 8000 },
    ],
  });

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      recordSale(userId, {
        idempotencyKey: `t3b-${i}`,
        lines:
          i % 2 === 0
            ? [{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 1 }]
            : [{ productId: b.id, quantity: 1 }, { productId: a.id, quantity: 1 }],
      }),
    ),
  );
  const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.deepEqual(
    failures.map((f) => String((f.reason as { cause?: { code?: string } })?.cause?.code ?? f.reason)),
    [],
    "every sale must succeed; a 40P01 here is a lock-ordering deadlock",
  );
  assert.equal((await reload(a.id)).quantityOnHand, 44);
  assert.equal((await reload(b.id)).quantityOnHand, 44);
});

test("rule 2: a client total the server disagrees with stops the sale and writes nothing", async () => {
  const userId = await newUser("t3c");
  const product = await newProduct(userId, { unitPrice: 25000 });
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 5, unitCost: 8000 }],
  });

  // The screen loaded at 250, then the owner repriced to 300 before checkout.
  await db.update(products).set({ unitPrice: 30000 }).where(eq(products.id, product.id));

  await assert.rejects(
    () =>
      recordSale(userId, {
        idempotencyKey: "t3c-stale",
        expectedTotal: 25000,
        lines: [{ productId: product.id, quantity: 1 }],
      }),
    (e: unknown) =>
      e instanceof ServiceError &&
      e.code === "price_changed" &&
      (e.details?.priced as { total: number }).total === 30000,
    "refused, carrying the server's pricing so the screen can re-display it",
  );
  assert.equal((await db.select().from(sales).where(eq(sales.userId, userId))).length, 0);
  assert.equal((await reload(product.id)).quantityOnHand, 5, "stock untouched");

  // Re-displayed at 300, the cashier confirms, and it goes through.
  const sale = await recordSale(userId, {
    idempotencyKey: "t3c-fresh",
    expectedTotal: 30000,
    lines: [{ productId: product.id, quantity: 1 }],
  });
  assert.equal(sale.total, 30000);
});

test("4. the same idempotency key twice creates one sale and returns the same id", async () => {
  const userId = await newUser("t4");
  const product = await newProduct(userId);
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 10, unitCost: 8000 }],
  });

  const input = {
    idempotencyKey: "t4-duplicate",
    lines: [{ productId: product.id, quantity: 2 }],
  };

  const first = await recordSale(userId, input);
  const second = await recordSale(userId, input);

  assert.equal(second.id, first.id, "the same sale comes back");
  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true, "the second call is flagged as a replay");

  const all = await db.select().from(sales).where(eq(sales.userId, userId));
  assert.equal(all.length, 1, "exactly one sale row exists");

  const after = await reload(product.id);
  assert.equal(after.quantityOnHand, 8, "stock was decremented once, not twice");
});

test("5. weighted average cost: 10 at 80 then 10 at 100 gives 90", async () => {
  const userId = await newUser("t5");
  const product = await newProduct(userId);

  // Paise throughout: 80 rupees is 8000 paise.
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 10, unitCost: 8000 }],
  });
  const afterFirst = await reload(product.id);
  assert.equal(afterFirst.averageCost, 8000, "first receipt sets the average");
  assert.equal(afterFirst.quantityOnHand, 10);

  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 10, unitCost: 10000 }],
  });
  const afterSecond = await reload(product.id);
  console.log(
    `      average_cost after 10@8000 then 10@10000 = ${afterSecond.averageCost} paise`,
  );
  assert.equal(afterSecond.averageCost, 9000, "(10*8000 + 10*10000) / 20 = 9000");
  assert.equal(afterSecond.quantityOnHand, 20);
  assert.ok(Number.isInteger(afterSecond.averageCost), "average cost stays an integer");
});

test("adjustStock requires a note and cannot drive stock negative", async () => {
  const userId = await newUser("t5b");
  const product = await newProduct(userId);
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 5, unitCost: 8000 }],
  });

  await assert.rejects(
    () => adjustStock(userId, { productId: product.id, delta: -1, note: "" }),
    /note is mandatory/,
    "an adjustment without a note is rejected before it reaches the database",
  );

  await assert.rejects(
    () => adjustStock(userId, { productId: product.id, delta: -99, note: "count" }),
    (e: unknown) => e instanceof ServiceError && e.code === "insufficient_stock",
  );

  const result = await adjustStock(userId, {
    productId: product.id,
    delta: -2,
    note: "breakage during a stock count",
  });
  assert.equal(result.quantityOnHand, 3);
  assert.equal(result.movement.reason, "adjustment");
  assert.equal(result.movement.note, "breakage during a stock count");
});

test("a sale never touches another account's products", async () => {
  const alice = await newUser("owner");
  const mallory = await newUser("intruder");
  const aliceProduct = await newProduct(alice);
  await receiveGoods(alice, {
    lines: [{ productId: aliceProduct.id, quantity: 10, unitCost: 8000 }],
  });

  // Mallory knows the uuid and asks for it directly. The WHERE clause filters
  // on user_id, so the row simply does not come back.
  await assert.rejects(
    () =>
      recordSale(mallory, {
        idempotencyKey: "cross-tenant",
        lines: [{ productId: aliceProduct.id, quantity: 1 }],
      }),
    (e: unknown) => e instanceof ServiceError && e.code === "not_found",
  );

  const after = await reload(aliceProduct.id);
  assert.equal(after.quantityOnHand, 10, "untouched");
});

test("a 10 rupee sale discount on a quantity-3 line at 100 writes one line with discount_amount 1000", async () => {
  const userId = await newUser("t7");
  const product = await newProduct(userId, { unitPrice: 10000 });
  await receiveGoods(userId, {
    lines: [{ productId: product.id, quantity: 5, unitCost: 6000 }],
  });

  const sale = await recordSale(userId, {
    idempotencyKey: "t7-discount",
    saleDiscount: 1000,
    lines: [{ productId: product.id, quantity: 3 }],
  });

  const lines = await db.select().from(saleLines).where(eq(saleLines.saleId, sale.id));
  assert.equal(lines.length, 1, "one line, not split at adjacent prices");
  assert.equal(lines[0].quantity, 3);
  assert.equal(lines[0].chargedPrice, 10000, "per-unit price untouched");
  assert.equal(lines[0].discountAmount, 1000, "the whole share sits on the line");
  assert.equal(sale.total, 29000);
  assert.equal(sale.discountTotal, 1000);

  const saleMoves = (await movementsFor(product.id)).filter((m) => m.reason === "sale");
  assert.deepEqual(saleMoves.map((m) => m.quantity), [-3], "still one movement of -3");
});

test("for every sale, the sum of line revenues equals sales.total exactly", async () => {
  // One deliberately awkward sale first, so the invariant is not only checked
  // against easy numbers: a percent-off with a line-level remainder, a BOGO
  // free line, and a sale discount that does not divide, all in one basket.
  const userId = await newUser("t8");
  const odd = await newProduct(userId, { unitPrice: 999 });
  const mug = await newProduct(userId, { unitPrice: 25000 });
  await receiveGoods(userId, {
    lines: [
      { productId: odd.id, quantity: 10, unitCost: 500 },
      { productId: mug.id, quantity: 10, unitCost: 8000 },
    ],
  });
  const window = {
    startsAt: new Date(Date.now() - 86_400_000),
    endsAt: new Date(Date.now() + 86_400_000),
  };
  await db.insert(promotions).values([
    { userId, productId: odd.id, type: "percent_off", percent: 33, ...window },
    { userId, productId: mug.id, type: "buy_x_get_y", buyQty: 2, getQty: 1, ...window },
  ]);
  const awkward = await recordSale(userId, {
    idempotencyKey: "t8-awkward",
    saleDiscount: 13,
    lines: [
      { productId: odd.id, quantity: 3 },
      { productId: mug.id, quantity: 3 },
    ],
  });
  const awkwardLines = await db
    .select()
    .from(saleLines)
    .where(eq(saleLines.saleId, awkward.id));
  assert.ok(
    awkwardLines.some((l) => l.discountAmount > 0),
    "the awkward sale really did put something in discount_amount",
  );

  // Computed in SQL, over EVERY sale any test in this run has written.
  const mismatches = await db.execute<{ id: string; total: number; revenue: number }>(sql`
    SELECT s.id, s.total,
           SUM(l.quantity * l.charged_price - l.discount_amount)::integer AS revenue
      FROM ${sales} s
      JOIN ${saleLines} l ON l.sale_id = s.id
     GROUP BY s.id, s.total
    HAVING s.total <> SUM(l.quantity * l.charged_price - l.discount_amount)
  `);
  const count = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sales}`);
  console.log(
    `      checked ${count.rows[0].n} sales: sum(quantity x charged_price - discount_amount) = total, ` +
      `${mismatches.rows.length} mismatches`,
  );
  assert.deepEqual(mismatches.rows, [], "line revenues must sum to sales.total");
  assert.ok(count.rows[0].n >= 5, "the invariant must have examined real sales");
});

test("6. reconciliation: for every product, the ledger sums to quantity_on_hand", async () => {
  let checked = 0;
  for (const userId of createdUsers) {
    const drift = await reconcileStock(userId);
    assert.deepEqual(drift, [], `ledger drift for user ${userId}: ${JSON.stringify(drift)}`);
    checked++;
  }
  console.log(`      reconciled every product across ${checked} accounts, zero drift`);
  assert.ok(checked > 0, "the reconciliation must actually have examined something");
});

test("sales, sale_lines and stock_movements are append-only in the source", async () => {
  // DESIGN section 6: append-only "by convention, enforced in the service
  // layer". A convention nothing checks is a convention that decays, so this
  // greps the source for the statements that would break it.
  const appendOnly = ["sales", "saleLines", "stockMovements"];
  const offenders: string[] = [];

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
    });

  for (const file of walk("src")) {
    if (file.endsWith(".test.ts")) continue;
    const source = readFileSync(file, "utf8")
      // Strip comments so the prose in this codebase (which discusses UPDATE
      // and DELETE at length) does not trip the check.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    for (const table of appendOnly) {
      if (new RegExp(`\\.(update|delete)\\(\\s*${table}\\s*\\)`).test(source)) {
        offenders.push(`${file}: .update/.delete(${table})`);
      }
    }
    const rawSql = source.match(
      /\b(UPDATE|DELETE\s+FROM)\s+(sales|sale_lines|stock_movements)\b/i,
    );
    if (rawSql) offenders.push(`${file}: raw ${rawSql[0]}`);
  }

  assert.deepEqual(offenders, [], `append-only tables are mutated in: ${offenders.join("; ")}`);
});
