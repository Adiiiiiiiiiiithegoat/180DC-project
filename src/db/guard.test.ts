/** The test runner cannot be pointed at production. No database needed: the guard fires before a connection. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNotProductionUnderTest } from "./index";

// The pooled (-pooler) and direct spellings of the same Neon branch both
// contain the bare endpoint ID, and the guard matches on that substring
// rather than the full hostname — so both are refused. Both are tested here,
// not just the pooled one .env.local actually uses, so this stays true even
// if that changes.
const PROD_POOLED = "postgresql://u:p@ep-jolly-mouse-aevwn5qm-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
const PROD_DIRECT = "postgresql://u:p@ep-jolly-mouse-aevwn5qm.c-2.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
const DEV = "postgresql://u:p@ep-some-other-branch-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";

test("under the test runner, a production DATABASE_URL is refused, pooled or direct", () => {
  assert.throws(() => assertNotProductionUnderTest(PROD_POOLED, "child-v8"), /Refusing to run tests against the production database/);
  assert.throws(() => assertNotProductionUnderTest(PROD_DIRECT, "child-v8"), /Refusing to run tests against the production database/);
  assert.doesNotThrow(() => assertNotProductionUnderTest(DEV, "child-v8"));
});

test("outside the test runner (the app itself) production is, of course, allowed", () => {
  assert.doesNotThrow(() => assertNotProductionUnderTest(PROD_POOLED, "")); // "" = no NODE_TEST_CONTEXT
});
