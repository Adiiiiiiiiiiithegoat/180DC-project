/**
 * Phase 1 verification. Proves, against a real Postgres, the four things the
 * build prompt asks for. Run with `npm run verify:phase1`.
 *
 * This DROPS AND RECREATES the `public` schema, because "applies cleanly to an
 * empty database" is only proven on an actually empty database. It refuses to
 * run unless you pass --reset, so it cannot be triggered by a stray npm script.
 */
import "./env";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq, sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import * as authSchema from "../src/db/auth-schema";

const { products } = schema;
const { users } = authSchema;

if (!process.argv.includes("--reset")) {
  console.error("Refusing to run: this drops the public schema. Pass --reset.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Drizzle wraps driver errors in a DrizzleQueryError and hangs the pg
 * DatabaseError off `.cause`, so `err.constraint` is undefined at the top
 * level. Unwrap it, because "the insert threw" is a much weaker claim than
 * "the insert was rejected by THIS constraint with THIS SQLSTATE" — a NOT NULL
 * violation or a typo in a column name would satisfy the former.
 */
function pgError(e: unknown) {
  const top = e as { cause?: unknown };
  const cause = (top?.cause ?? e) as {
    code?: string;
    constraint?: string;
    table?: string;
    detail?: string;
    message?: string;
  };
  return {
    code: cause?.code,
    constraint: cause?.constraint,
    table: cause?.table,
    describe: () =>
      `${cause?.code ?? "?"} ${cause?.constraint ?? cause?.message ?? "?"}`,
  };
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const db = drizzle(pool, { schema: { ...schema, ...authSchema } });

async function main() {
  console.log("\n=== 1. Migration applies cleanly to an empty database ===");
  // The `drizzle` schema holds __drizzle_migrations, the journal of which
  // migrations have run. Dropping only `public` leaves that journal behind, so
  // the next migrate() decides everything is already applied, does nothing, and
  // hands you a database with no tables. Both schemas go.
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public;
  `);
  const before = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema IN ('public','drizzle')`,
  );
  check(
    "database starts empty (public and drizzle journal both gone)",
    before.rows[0].n === 0,
    `${before.rows[0].n} tables`,
  );

  await migrate(db, { migrationsFolder: "./drizzle" });

  const after = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  const tables = after.rows.map((r) => r.table_name as string);
  console.log(`  tables created: ${tables.join(", ")}`);
  const expected = [
    "accounts", "products", "promotions", "receipt_lines", "receipts",
    "sale_lines", "sales", "sessions", "stock_movements", "supplier_aliases",
    "suppliers", "users", "verifications",
  ];
  const missing = expected.filter((t) => !tables.includes(t));
  check("every table from DESIGN section 6 exists", missing.length === 0, missing.join(","));

  const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname='pg_trgm'");
  check("pg_trgm enabled", ext.rowCount === 1);

  const trgm = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname='products_name_trgm_idx'",
  );
  check(
    "trigram GIN index on products.name",
    /gin.*gin_trgm_ops/i.test(trgm.rows[0]?.indexdef ?? ""),
    trgm.rows[0]?.indexdef,
  );

  const checks = await pool.query(
    `SELECT conname FROM pg_constraint WHERE contype='c'
       AND conrelid::regclass::text IN ('products','promotions','receipts','receipt_lines','sale_lines','stock_movements')
     ORDER BY conname`,
  );
  // Assert the exact set, not a count: a count catches "one went missing" but
  // happily passes if a constraint is missing and an unrelated one appeared.
  const foundChecks = checks.rows.map((r) => r.conname as string);
  const expectedChecks = [
    "products_average_cost_check", "products_lead_time_days_check",
    "products_quantity_on_hand_check", "products_reorder_point_check",
    "products_unit_price_check", "promotions_buy_qty_check",
    "promotions_get_qty_check", "promotions_percent_check",
    "promotions_shape_check", "promotions_type_check",
    "receipt_lines_quantity_check", "receipt_lines_unit_cost_check",
    "receipts_source_check", "receipts_status_check",
    "sale_lines_discount_amount_check", "sale_lines_quantity_check",
    "stock_movements_quantity_check",
    "stock_movements_reason_check",
  ];
  console.log(`  CHECK constraints (${foundChecks.length}): ${foundChecks.join(", ")}`);
  const missingChecks = expectedChecks.filter((c) => !foundChecks.includes(c));
  const extraChecks = foundChecks.filter((c) => !expectedChecks.includes(c));
  check(
    `all ${expectedChecks.length} CHECK constraints from DESIGN section 6 present, and no others`,
    missingChecks.length === 0 && extraChecks.length === 0,
    [
      missingChecks.length ? `missing: ${missingChecks.join(",")}` : "",
      extraChecks.length ? `unexpected: ${extraChecks.join(",")}` : "",
    ].filter(Boolean).join("; "),
  );

  // Two users, so the per-user SKU uniqueness test below has two tenants.
  const [alice] = await db.insert(users).values({ name: "Alice", email: "alice@test.local" }).returning();
  const [bob] = await db.insert(users).values({ name: "Bob", email: "bob@test.local" }).returning();
  check("uuid primary keys from the database", /^[0-9a-f-]{36}$/.test(alice.id), alice.id);

  console.log("\n=== 2. Negative quantity_on_hand is rejected by the database ===");
  try {
    await db.insert(products).values({
      userId: alice.id, name: "Impossible Mug", sku: "NEG-1",
      unitPrice: 25000, quantityOnHand: -1,
    });
    check("insert with quantity_on_hand = -1 rejected", false, "it was ACCEPTED");
  } catch (e) {
    const err = pgError(e);
    check(
      "rejected by the DATABASE as a check violation on products_quantity_on_hand_check",
      err.code === CHECK_VIOLATION &&
        err.constraint === "products_quantity_on_hand_check" &&
        err.table === "products",
      err.describe(),
    );
  }

  console.log("\n=== 3. SKU uniqueness is per user, not global ===");
  await db.insert(products).values({
    userId: alice.id, name: "Blue Mug", sku: "MUG-01", unitPrice: 25000,
  });
  try {
    await db.insert(products).values({
      userId: bob.id, name: "Bob's Blue Mug", sku: "MUG-01", unitPrice: 30000,
    });
    check("same SKU under a different user inserts", true);
  } catch (e) {
    check("same SKU under a different user inserts", false, (e as Error).message);
  }
  try {
    await db.insert(products).values({
      userId: alice.id, name: "Blue Mug Again", sku: "MUG-01", unitPrice: 25000,
    });
    check("same SKU twice under one user rejected", false, "it was ACCEPTED");
  } catch (e) {
    const err = pgError(e);
    check(
      "rejected by the DATABASE as a unique violation on products_user_sku_key",
      err.code === UNIQUE_VIOLATION &&
        err.constraint === "products_user_sku_key" &&
        err.table === "products",
      err.describe(),
    );
  }

  console.log("\n=== 4. Interactive transactions actually roll back ===");
  // The point of the exercise: Neon's HTTP driver cannot hold a session across
  // round-trips, so a "transaction" over it would commit the insert and the
  // product below would still be there. node-postgres holds one client for the
  // life of the transaction, so the throw rolls the insert back.
  const SKU = "ROLLBACK-1";
  try {
    await db.transaction(async (tx) => {
      await tx.insert(products).values({
        userId: alice.id, name: "Doomed Product", sku: SKU, unitPrice: 100,
      });
      const inside = await tx.select().from(products).where(eq(products.sku, SKU));
      check("row is visible INSIDE the transaction", inside.length === 1);
      throw new Error("deliberate rollback");
    });
    check("transaction propagated the error", false, "no error escaped");
  } catch (e) {
    check("transaction propagated the error", (e as Error).message === "deliberate rollback");
  }
  const afterRollback = await db.select().from(products).where(eq(products.sku, SKU));
  check(
    "row is GONE after rollback (driver supports interactive transactions)",
    afterRollback.length === 0,
    `${afterRollback.length} rows found`,
  );

  // Same shape, committed, so a passing rollback test cannot be a write that
  // silently never happened.
  await db.transaction(async (tx) => {
    await tx.insert(products).values({
      userId: alice.id, name: "Committed Product", sku: "COMMIT-1", unitPrice: 100,
    });
  });
  const committed = await db.select().from(products).where(eq(products.sku, "COMMIT-1"));
  check("control: a committed transaction does persist", committed.length === 1);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
