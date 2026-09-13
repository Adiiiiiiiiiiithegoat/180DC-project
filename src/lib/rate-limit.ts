/**
 * Abuse protection for the assistant — a runaway ceiling, not a tight budget
 * control (the Groq key is on a paid balance). Two reasons a per-user limit
 * alone would not do: the README's demo credentials are shared by every
 * grader, so a per-user limit is a shared limit; and sign-up is open, so a
 * script can dodge a per-user limit by creating a new account. Hence two
 * tiers, both counted against `assistant_usage` (one row per accepted
 * request):
 *
 *   - per user, per trailing hour — sized for someone exploring the demo
 *   - global, per trailing day — a ceiling on the whole app, including a
 *     script that keeps making new accounts
 *
 * Postgres-backed, not an in-process Map: Vercel runs multiple function
 * instances, and an in-memory counter would give each one its own count,
 * silently multiplying the real limit.
 *
 * checkAssistantUsage and recordAssistantUsage are two statements, not one
 * transaction: a burst of truly concurrent requests can each pass the check
 * before any of them has recorded, and overshoot the cap by a handful. That's
 * deliberately left as-is, unlike recordSale's conditional stock decrement
 * (services.ts, DESIGN.md section 5 rule 1), which *must* be race-free because
 * a lost race there sells a unit of stock that does not exist — a correctness
 * bug a customer feels. Here the count is a coarse abuse ceiling: the exact
 * number of requests let through past the limit carries no correctness
 * weight, only a cost one, so the two extra requests a race might allow are
 * cheaper to accept than the transaction (and the row locking it implies) is
 * worth adding for a limit whose defaults already sit a comfortable multiple
 * above real usage.
 */
import { and, count, eq, gte, min, type SQL } from "drizzle-orm";
import { db } from "../db";
import { assistantUsage } from "../db/schema";

// Read per call, not captured at module load: so tests can set these after
// import, and so a value changed in Vercel's dashboard takes effect on the
// next request into a warm instance rather than needing a redeploy.
const userHourlyLimit = () => Number(process.env.ASSISTANT_USER_HOURLY_LIMIT ?? 30);
const globalDailyLimit = () => Number(process.env.ASSISTANT_GLOBAL_DAILY_LIMIT ?? 500);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type UsageCheck = { ok: true } | { ok: false; scope: "user" | "global"; retryAfterSeconds: number };

/** Seconds until the oldest row in the window ages out, i.e. until under the limit again. */
async function retryAfterSeconds(windowMs: number, where: SQL) {
  const [{ oldest }] = await db.select({ oldest: min(assistantUsage.createdAt) }).from(assistantUsage).where(where);
  if (!oldest) return Math.ceil(windowMs / 1000);
  return Math.max(1, Math.ceil((oldest.getTime() + windowMs - Date.now()) / 1000));
}

export async function checkAssistantUsage(userId: string): Promise<UsageCheck> {
  const dayStart = new Date(Date.now() - DAY_MS);
  const hourStart = new Date(Date.now() - HOUR_MS);
  const globalWhere = gte(assistantUsage.createdAt, dayStart);
  // Non-null: `and` only returns undefined given zero conditions, never two.
  const userWhere = and(eq(assistantUsage.userId, userId), gte(assistantUsage.createdAt, hourStart))!;

  const [[{ value: globalCount }], [{ value: userCount }]] = await Promise.all([
    db.select({ value: count() }).from(assistantUsage).where(globalWhere),
    db.select({ value: count() }).from(assistantUsage).where(userWhere),
  ]);

  if (globalCount >= globalDailyLimit()) {
    return { ok: false, scope: "global", retryAfterSeconds: await retryAfterSeconds(DAY_MS, globalWhere) };
  }
  if (userCount >= userHourlyLimit()) {
    return { ok: false, scope: "user", retryAfterSeconds: await retryAfterSeconds(HOUR_MS, userWhere) };
  }
  return { ok: true };
}

/** Called only once checkAssistantUsage has allowed the request through. */
export async function recordAssistantUsage(userId: string): Promise<void> {
  await db.insert(assistantUsage).values({ userId });
}
