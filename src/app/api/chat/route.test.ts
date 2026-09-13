/**
 * The rate limit is enforced in the route handler itself, not only in the
 * helper it calls — this test calls the exported POST directly with a real
 * Better Auth session cookie (signed up here, not mocked), the same way a
 * script hitting /api/chat would if it skipped the browser and the "Ask"
 * button entirely. Browser-side enforcement would be worthless against
 * exactly this.
 *
 * The env import must come first: ../../../db builds its Pool from
 * DATABASE_URL at module load.
 *
 * route.ts is imported dynamically, after mocking next/navigation, and only
 * inside before(): session.ts imports `redirect` from next/navigation at
 * module scope (for requireUserId, which this route doesn't even use), and
 * that module's shared app-router context calls React.createContext at load
 * time. Outside Next's own build — which gives Route Handlers a React build
 * where that's safe — that throws under plain Node. The mock sidesteps a
 * bundling detail rather than exercising it; the assistant's own rate-limit
 * enforcement is what stays real. Requires --experimental-test-module-mocks
 * (see package.json's test script) for mock.module.
 */
import "../../../../scripts/env";
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../../../db";
import { assistantUsage } from "../../../db/schema";
import { auth } from "../../../lib/auth";

let POST: typeof import("./route").POST;

/**
 * The response from signUpEmail's Set-Cookie headers, turned into the single
 * Cookie header a later request needs. `Headers.get("set-cookie")` folds
 * multiple Set-Cookie values into one comma-joined string per the Fetch spec
 * (unusable here), so this reads them individually via getSetCookie().
 */
function cookieHeaderFrom(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((setCookie) => setCookie.split(";")[0])
    .join("; ");
}

let cookie = "";

before(async () => {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public;
  `);
  await migrate(db, { migrationsFolder: "./drizzle" });

  mock.module("next/navigation", {
    // `exports` (the current option name) isn't in this project's @types/node
    // (^20) yet; `namedExports` is the same feature under its older, now-
    // deprecated name and is what the installed types know about.
    namedExports: {
      redirect: () => {
        throw new Error("redirect() is unreachable from this route — sessionUserId never calls it");
      },
    },
  });
  ({ POST } = await import("./route"));

  // A real sign-up through Better Auth's own server API, exactly like the
  // sign-up page uses, so the session cookie below is the real thing rather
  // than a fabricated header sessionUserId() would never actually see.
  const signUpResponse = await auth.api.signUpEmail({
    body: { email: `route-test-${Date.now()}@test.local`, password: "password123", name: "Route Test" },
    asResponse: true,
  });
  cookie = cookieHeaderFrom(signUpResponse.headers);
  assert.ok(cookie, "sign-up must actually set a session cookie for this test to mean anything");

  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  const userId = session!.user.id;

  // Put the account over the global cap directly (not by calling the route
  // 500 times): two rows against a global limit of 2.
  process.env.ASSISTANT_USER_HOURLY_LIMIT = "1000"; // isolate this test to the global tier only
  process.env.ASSISTANT_GLOBAL_DAILY_LIMIT = "2";
  await db.insert(assistantUsage).values([{ userId }, { userId }]);
});

after(async () => {
  await pool.end();
});

test("over the global cap: POST /api/chat is blocked before Groq and calls fetch zero times", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  // createAssistant's model calls go through fetch; if this fires, the route
  // reached Groq despite the request being over the limit.
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("no network call should happen for a blocked assistant request");
  }) as typeof fetch;

  try {
    const response = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }] }),
      }),
    );
    assert.equal(response.status, 429);
    assert.match(await response.text(), /^usage_limited:global:\d+$/);
    assert.equal(fetchCalls, 0, "a blocked request must make zero calls to Groq");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("no session cookie: still 401, rate limiting never even runs", async () => {
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    }),
  );
  assert.equal(response.status, 401);
});
