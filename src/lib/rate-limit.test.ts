/**
 * Integration tests against a real Postgres — the DB is exactly what makes
 * this a real ceiling across function instances (see rate-limit.ts). Each
 * test picks limits well under Node's default timeout by inserting usage rows
 * directly rather than calling checkAssistantUsage in a loop.
 *
 * The env import must come first: ../db builds its Pool from DATABASE_URL at
 * module load.
 */
import "../../scripts/env";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, pool } from "../db";
import { users } from "../db/auth-schema";
import { assistantUsage } from "../db/schema";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { checkAssistantUsage, recordAssistantUsage } from "./rate-limit";

let seq = 0;
async function newUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ name: label, email: `${label}-${Date.now()}-${seq++}@test.local` })
    .returning();
  return u.id;
}

/** Backdates rows so a test can put a user or the whole table "at the limit" without 30 real inserts and without waiting on the clock. */
async function seedUsage(userId: string, count: number, ageMs = 0) {
  if (count <= 0) return;
  await db.insert(assistantUsage).values(
    Array.from({ length: count }, () => ({ userId, createdAt: new Date(Date.now() - ageMs) })),
  );
}

before(async () => {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public;
  `);
  await migrate(db, { migrationsFolder: "./drizzle" });
  process.env.ASSISTANT_USER_HOURLY_LIMIT = "3";
  process.env.ASSISTANT_GLOBAL_DAILY_LIMIT = "5";
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.delete(assistantUsage);
});

test("under both limits: unaffected", async () => {
  const userId = await newUser("under-limit");
  await seedUsage(userId, 2); // limit is 3
  const result = await checkAssistantUsage(userId);
  assert.deepEqual(result, { ok: true });
});

test("per-user cap: the 4th request in the trailing hour is blocked (limit 3)", async () => {
  const userId = await newUser("user-cap");
  await seedUsage(userId, 3);
  const result = await checkAssistantUsage(userId);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.scope, "user");
    assert.ok(result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 3600, "retry-after is within the hour window");
  }
});

test("global cap: blocked once the trailing day holds the limit, regardless of whose rows they are (limit 5)", async () => {
  const a = await newUser("global-a");
  const b = await newUser("global-b");
  const c = await newUser("global-c");
  // 2 + 2 + 1 = 5, none of them individually at the per-user limit of 3
  await seedUsage(a, 2);
  await seedUsage(b, 2);
  await seedUsage(c, 1);

  const result = await checkAssistantUsage(a);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.scope, "global", "no single user is over their own cap, so this must be the shared one");
    assert.ok(result.retryAfterSeconds > 0 && result.retryAfterSeconds <= 24 * 3600);
  }
});

test("counters are isolated per user: user B's usage does not consume user A's allowance", async () => {
  const a = await newUser("isolated-a");
  const b = await newUser("isolated-b");
  await seedUsage(b, 3); // b is at the per-user cap; global stays at 3, under 5

  const result = await checkAssistantUsage(a);
  assert.deepEqual(result, { ok: true }, "a's own count is still zero");
});

test("recordAssistantUsage is what checkAssistantUsage counts, end to end", async () => {
  const userId = await newUser("record-e2e");
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await checkAssistantUsage(userId), { ok: true }, `request ${i + 1} of 3 should be allowed`);
    await recordAssistantUsage(userId);
  }
  const blocked = await checkAssistantUsage(userId);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.scope, "user");
});

test("a row older than the window does not count against either limit", async () => {
  const userId = await newUser("expired-rows");
  await seedUsage(userId, 3, 2 * 60 * 60 * 1000); // 2 hours old, hourly window is 1 hour
  const result = await checkAssistantUsage(userId);
  assert.deepEqual(result, { ok: true });
});
