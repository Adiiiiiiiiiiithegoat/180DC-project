import { test } from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "ai";
import { retryAfterSeconds, withBackoff, type Busy } from "./backoff";

const limited = (headers: Record<string, string> = {}, statusCode = 429) =>
  new APICallError({
    message: "rate limited",
    url: "https://api.groq.com",
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
  });

test("a 429 waits for retry-after, says so, then succeeds on the same call", async () => {
  const events: Busy[] = [];
  const slept: number[] = [];
  let calls = 0;
  const result = await withBackoff(
    async () => {
      calls++;
      if (calls < 3) throw limited({ "retry-after": "7" });
      return "answer";
    },
    (b) => events.push(b),
    async (ms) => void slept.push(ms),
  );
  assert.equal(result, "answer");
  assert.equal(calls, 3);
  assert.deepEqual(slept, [7000, 7000]);
  assert.deepEqual(events, [
    { state: "waiting", seconds: 7, attempt: 1 },
    { state: "waiting", seconds: 7, attempt: 2 },
    { state: "resumed" },
  ]);
});

test("no retry-after header backs off exponentially; 503 counts as busy too", async () => {
  const slept: number[] = [];
  let calls = 0;
  await withBackoff(
    async () => {
      if (++calls < 3) throw limited({}, 503);
      return "ok";
    },
    () => {},
    async (ms) => void slept.push(ms),
  );
  assert.deepEqual(slept, [2000, 4000]);
});

test("a daily limit (wait over a minute) and a non-transient error are thrown at once", async () => {
  const noSleep = async () => assert.fail("must not wait");
  await assert.rejects(withBackoff(() => Promise.reject(limited({ "retry-after": "3600" })), () => {}, noSleep));
  await assert.rejects(withBackoff(() => Promise.reject(limited({}, 400)), () => {}, noSleep));
  // Groq's "request too large for your per-minute limit": a 429 no wait can fix.
  await assert.rejects(withBackoff(() => Promise.reject(limited({ "x-should-retry": "false" })), () => {}, noSleep));
});

test("gives up after five attempts rather than retrying forever", async () => {
  let calls = 0;
  await assert.rejects(
    withBackoff(() => { calls++; return Promise.reject(limited({ "retry-after": "1" })); }, () => {}, async () => {}),
  );
  assert.equal(calls, 5);
});

test("retry-after as an HTTP date", () => {
  const now = Date.parse("2026-09-10T10:00:00Z");
  assert.equal(retryAfterSeconds({ "retry-after": "Thu, 10 Sep 2026 10:00:12 GMT" }, now), 12);
  assert.equal(retryAfterSeconds({}, now), undefined);
});
