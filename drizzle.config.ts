import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL! },
  // pg_trgm must exist before products_name_trgm_idx is created; the extension
  // is created in drizzle/0000_extensions.sql, which sorts first.
  extensionsFilters: ["postgis"],
  verbose: true,
  strict: false,
});
