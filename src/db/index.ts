import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import * as authSchema from "./auth-schema";

/**
 * Driver choice: `pg` (node-postgres) over Neon's HTTP driver.
 *
 * DESIGN.md §10. Neon's HTTP driver (`@neondatabase/serverless` in http mode)
 * issues one-shot, non-interactive statements. The sale in §4 is a multi-step
 * interactive transaction — read prices, insert sale, insert lines, insert
 * movements, conditionally decrement, inspect the affected row count, and roll
 * the whole thing back on a stockout. That needs a session held open across
 * round-trips, which HTTP cannot give us.
 *
 * Of the two acceptable options in §10 (`pg` through PgBouncer, or
 * `neon-websockets`) we take `pg`. On Vercel, Fluid Compute reuses warm
 * instances across concurrent requests, so a TCP pool is safe rather than the
 * connection-storm hazard it was under one-request-per-instance serverless.
 * DATABASE_URL points at Neon's *pooled* endpoint (`-pooler`), which is
 * PgBouncer in transaction mode: a checked-out client owns a server connection
 * for the life of its transaction, which is exactly the guarantee the
 * conditional UPDATE in §5 rule 1 depends on.
 *
 * ponytail: no prepared statements anywhere — PgBouncer transaction mode does
 * not support them, and Drizzle's node-postgres driver does not use them unless
 * asked.
 */
const globalForDb = globalThis as unknown as { pool?: Pool };

export const pool =
  globalForDb.pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    // 10 for the app. The seed raises it (scripts/env.ts --pool) because it
    // replays thousands of sales and is bound by round-trip latency.
    max: Number(process.env.PG_POOL_MAX ?? 10),
  });

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;

export const db = drizzle(pool, { schema: { ...schema, ...authSchema } });
export type DB = typeof db;
