import "./env";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
