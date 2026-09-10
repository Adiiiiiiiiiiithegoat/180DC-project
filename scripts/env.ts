/**
 * Env loading for scripts run outside Next.js (which loads its own env files).
 *
 * Default is .env.test because the scripts that rely on the default are
 * destructive: verify:phase1 drops the public schema and the integration tests
 * write freely. It points at the Neon `dev` branch.
 *
 * Anything else is chosen explicitly with `--env <file>` — the seed targets
 * .env.development.local (the `local` branch), and a production seed names its
 * file on the command line so it cannot happen by accident. A CLI flag rather
 * than an environment variable because npm runs scripts under cmd.exe on
 * Windows, where `VAR=x command` does not work.
 *
 * .env.local (maintained by `neon link`) fills in only what the chosen file did
 * not set; dotenv never overwrites a variable that is already defined.
 */
import { config } from "dotenv";

const flag = process.argv.indexOf("--env");
const file = flag > -1 ? process.argv[flag + 1] : (process.env.ENV_FILE ?? ".env.test");

config({ path: file, quiet: true });
config({ path: ".env.local", quiet: true });

// `--pool N` sizes the shared connection pool (src/db). Set here because this
// module is imported before anything that creates the pool.
const poolFlag = process.argv.indexOf("--pool");
if (poolFlag > -1) process.env.PG_POOL_MAX = process.argv[poolFlag + 1];

export const envFile = file;
