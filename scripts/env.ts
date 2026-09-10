/**
 * Env loading for scripts run outside Next.js (which loads .env.local itself).
 *
 * .env.test wins because every script that imports this is destructive or
 * writes test data: verify:phase1 drops the public schema, the Phase 3
 * integration tests write sales and movements freely. It points at the Neon
 * `dev` branch. .env.local — maintained by `neon link`, pointing at the linked
 * branch — only fills in what .env.test did not set.
 *
 * dotenv does not overwrite an already-set variable, so the first file to
 * define DATABASE_URL wins. Set ENV_FILE to override deliberately.
 */
import { config } from "dotenv";

config({ path: process.env.ENV_FILE ?? ".env.test" });
config({ path: ".env.local" });
