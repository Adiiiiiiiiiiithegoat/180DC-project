/**
 * Groq's free tier allows 8,000 tokens and roughly 30 requests a minute, and
 * one assistant turn is several model calls (each tool round trip resends the
 * conversation). Hitting the limit mid-answer is normal, not exceptional.
 *
 * So a 429 is waited out rather than surfaced: honour `retry-after`, tell the
 * user we are waiting (onBusy), then try the same call again. The call is one
 * model request, so a retry never re-runs a tool: tool calls already made in
 * this turn stay made, including an approved write.
 *
 * A wait longer than a minute means a daily limit, and waiting would look
 * like a hang, so that one is thrown for the route to explain instead.
 */
import { APICallError, type LanguageModelMiddleware } from "ai";

export type Busy = { state: "waiting"; seconds: number; attempt: number } | { state: "resumed" };

const MAX_ATTEMPTS = 5;
const MAX_WAIT_SECONDS = 60;

/** `retry-after` is either seconds or an HTTP date. */
export function retryAfterSeconds(headers: Record<string, string> | undefined, now = Date.now()) {
  const value = headers?.["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - now) / 1000);
}

/**
 * Rate limited, or the provider is briefly over capacity. Anything else is a
 * real error — including a 429 the provider marks `x-should-retry: false`:
 * Groq's "request too large for your per-minute limit", which no wait fixes.
 */
const isTransient = (e: unknown): e is APICallError =>
  APICallError.isInstance(e) &&
  (e.statusCode === 429 || (e.statusCode ?? 0) >= 500) &&
  e.responseHeaders?.["x-should-retry"] !== "false";

export async function withBackoff<T>(
  call: () => PromiseLike<T>,
  onBusy: (busy: Busy) => void,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await call();
      if (attempt > 1) onBusy({ state: "resumed" });
      return result;
    } catch (e) {
      if (!isTransient(e) || attempt === MAX_ATTEMPTS) throw e;
      // No header: 2, 4, 8, 16 seconds.
      const seconds = Math.ceil(retryAfterSeconds(e.responseHeaders) ?? 2 ** attempt);
      if (seconds > MAX_WAIT_SECONDS) throw e;
      onBusy({ state: "waiting", seconds, attempt });
      await sleep(seconds * 1000);
    }
  }
}

/** Wraps every model request the agent makes, streaming or not. */
export function backoffMiddleware(onBusy: (busy: Busy) => void): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapGenerate: ({ doGenerate }) => withBackoff(doGenerate, onBusy),
    wrapStream: ({ doStream }) => withBackoff(doStream, onBusy),
  };
}
