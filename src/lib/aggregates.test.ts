/**
 * Money past 2^31 paise (about ₹2.1 crore) must survive every step: the
 * integer columns hold per-unit values, but quantity × cost does not fit in
 * Postgres `integer`, so the stock-value products are `::bigint` in SQL and
 * bigint is parsed to a JS number (exact to 2^53) in src/db. Dev branch.
 */
import "../../scripts/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../db";
import { users } from "../db/auth-schema";
import { products } from "../db/schema";
import { getInventoryStatus } from "./analytics";
import { receiveGoods } from "./services";

before(() => migrate(db, { migrationsFolder: "./drizzle" }));
after(() => pool.end());

test("stock value above 2^31 paise is exact, in the rows and in the totals", async () => {
  const [u] = await db.insert(users).values({ name: "big", email: `big-${Date.now()}@test.local` }).returning();
  const rows = await db
    .insert(products)
    .values([
      { userId: u.id, name: "Gold Coin 10g", sku: "BIG-1", unitPrice: 150_000 },
      { userId: u.id, name: "Gold Coin 20g", sku: "BIG-2", unitPrice: 150_000 },
    ])
    .returning();
  // 30,000 units at ₹1,000.00 each: 3,000,000,000 paise per product, past 2,147,483,647.
  await receiveGoods(u.id, { lines: rows.map((p) => ({ productId: p.id, quantity: 30_000, unitCost: 100_000 })) });

  const status = await getInventoryStatus(u.id);
  assert.ok(3_000_000_000 > 2 ** 31);
  for (const item of status.items) {
    assert.equal(item.stockValueAtCostPaise, 3_000_000_000, item.name);
    assert.equal(typeof item.stockValueAtCostPaise, "number");
  }
  assert.equal(status.totals.stockValueAtCostPaise, 6_000_000_000);
  assert.equal(status.totals.stockValueAtRetailPaise, 9_000_000_000);
  assert.equal(status.totals.unitsOnHand, 60_000);
});
