import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db";
import * as authSchema from "../db/auth-schema";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  // DESIGN.md §6 writes `REFERENCES users(id)`. Better Auth's generator
  // defaults to the singular `user`; renaming here keeps the emitted SQL
  // identical to the document rather than needing a footnote forever.
  user: { modelName: "users" },
  session: { modelName: "sessions", expiresIn: 60 * 60 * 24 * 7 },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  advanced: {
    database: {
      // DESIGN.md §6 wants uuid primary keys across every table. Better Auth
      // otherwise mints its own string ids, which will not cast to uuid.
      // `generateId: false` hands id generation to the column default
      // (gen_random_uuid()).
      generateId: false,
    },
  },
});
