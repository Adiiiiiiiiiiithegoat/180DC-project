/** The test runner cannot be pointed at production. No database needed: the guard fires before a connection. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNotProductionUnderTest } from "./index";

const PROD = "postgresql://u:p@ep-jolly-mouse-aevwn5qm-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";
const DEV = "postgresql://u:p@ep-some-other-branch-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=verify-full";

test("under the test runner, a production DATABASE_URL is refused", () => {
  assert.throws(() => assertNotProductionUnderTest(PROD, "child-v8"), /Refusing to run tests against the production database/);
  assert.doesNotThrow(() => assertNotProductionUnderTest(DEV, "child-v8"));
});

test("outside the test runner (the app itself) production is, of course, allowed", () => {
  assert.doesNotThrow(() => assertNotProductionUnderTest(PROD, "")); // "" = no NODE_TEST_CONTEXT
});
