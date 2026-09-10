/**
 * DESIGN.md section 8 — the assistant.
 *
 * The authorisation boundary is structural, not a prompt:
 *
 *   - The tools are built per request by `assistantTools(userId)`, closing over
 *     the id the route read from the session. No tool's input schema has a
 *     user field, so the model has no way to even express "for another
 *     account" — the parameter it would need does not exist.
 *   - Every tool calls a function from analytics.ts or services.ts, whose SQL
 *     filters on that user id in its WHERE clause. There is no run_sql and no
 *     tool takes a query, a table name, or a column name.
 *   - The only write is updateProductSettings: reorder point, price, active
 *     status. Its schema is strict, so quantity cannot be smuggled in, and it
 *     needs human approval (AI SDK tool approval) before execute ever runs.
 *
 * `server-only` makes importing this file from a client component a build
 * error: the Groq key and tool execution stay on the server.
 */
import "server-only";
import { groq } from "@ai-sdk/groq";
import {
  ToolLoopAgent,
  stepCountIs,
  tool,
  wrapLanguageModel,
  type InferUITools,
  type UIMessage,
} from "ai";
import {
  findProduct,
  getInventoryStatus,
  getProductPerformance,
  getReorderSuggestions,
  getSalesSummary,
  getSalesTimeSeries,
  getStockHistory,
} from "./analytics";
import { backoffMiddleware, type Busy } from "./backoff";
import { formatPaise, formatRupees } from "./money";
import { updateProductSettings } from "./services";
import {
  findProductInputSchema,
  inventoryStatusInputSchema,
  productPerformanceInputSchema,
  reorderSuggestionsInputSchema,
  salesSummaryInputSchema,
  salesTimeSeriesInputSchema,
  stockHistoryInputSchema,
  updateProductSettingsSchema,
} from "./validation";

/**
 * The brief named llama-3.3-70b-versatile; Groq no longer serves it (404
 * model_not_found as of September 2026). gpt-oss-120b is Groq's strongest
 * tool-calling model on the free tier.
 */
export const MODEL = "openai/gpt-oss-120b";

const dayMonthYear = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

// Per-unit rates stay exact even in rows: "₹12.50" rounded to "₹13" would misstate a price.
const EXACT_IN_ROWS = /^(unitPrice|averageCost)Paise$/;

/**
 * The model-facing serialisation. Only what the model reads changes here;
 * the dashboard and the database keep the functions' full output.
 *
 * Money leaves SQL as integer paise, in fields named `...Paise`. The model
 * gets those formatted as rupees under the name without the suffix, so it
 * quotes "₹3,14,159.00" rather than dividing 31415900 by 100 itself. Figures
 * inside rows (per product, per week) are rounded to whole rupees: paise cost
 * tokens and say nothing there. Top-level totals keep their paise, so the
 * shop-wide figures the assistant quotes are identical to the dashboard's.
 * Dates go "2026-08-11" to "11 Aug 2026", because an open model will happily
 * read the ISO form as 8 November. Nulls are dropped: an absent field reads
 * as "none" and costs no tokens.
 */
export function forModel(value: unknown, inRow = false): unknown {
  if (Array.isArray(value)) return value.map((v) => forModel(v, true));
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return dayMonthYear.format(new Date(`${value}T00:00:00Z`));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) =>
        k.endsWith("Paise") && typeof v === "number"
          ? [k.slice(0, -5), inRow && !EXACT_IN_ROWS.test(k) ? formatRupees(v) : formatPaise(v)]
          : [k, forModel(v, inRow)],
      ),
  );
}

/** `o` without `keys`: fields the model never uses stay out of its context window. */
function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
}

/** The assistant's default for getProductPerformance when the model gives no limit. */
const PERFORMANCE_LIMIT = 10;

/** The eight tools, bound to one account. `userId` is captured here and nowhere else. */
export function assistantTools(userId: string) {
  return {
    findProduct: tool({
      description:
        "Look up products by name or SKU to get their ids, stock on hand and price. " +
        "Call this first whenever the user names a particular product and you need its id " +
        "(getStockHistory and updateProductSettings require one). Returns up to 5 candidates, " +
        "best first, with a match score from 0 to 1; if more than one is a plausible match, ask the " +
        "user which they mean instead of guessing. Do not use it to list products or find low stock " +
        "(use getInventoryStatus) or for sales figures (use getProductPerformance).",
      inputSchema: findProductInputSchema,
      execute: async (input) => {
        const r = await findProduct(userId, input);
        return forModel({ ...r, candidates: r.candidates.map((c) => omit(c, "category")) });
      },
    }),

    getInventoryStatus: tool({
      description:
        "What is on the shelf right now: per active product the units on hand, reorder point, lead " +
        "time, status (out / low / ok), price, average cost and stock value; plus shop-wide totals " +
        "(units on hand, stock value at cost and at retail, how many are low or out). " +
        "Use for: what's running low, what's out of stock, how much stock do I have, what is my " +
        "stock worth. 'low' means at or below the product's own reorder point. It knows nothing " +
        "about sales: for how fast things sell, when they will run out, or how much to order, use " +
        "getReorderSuggestions.",
      inputSchema: inventoryStatusInputSchema,
      execute: async (input) => {
        const r = await getInventoryStatus(userId, input);
        return forModel({
          ...r,
          items: r.items.map((p) => omit(p, "id", "sku", "category", "unitPricePaise", "averageCostPaise")),
        });
      },
    }),

    getSalesSummary: tool({
      description:
        "Shop-wide sales totals for a window of complete days: revenue, cost of goods, gross margin " +
        "and margin %, transactions, units, average basket, discounts given. By default also returns " +
        "the same figures for the equal-length window just before it, and the change (amount, %, and " +
        "margin percentage points). Use for: how did the last week / 30 days / month go, is that " +
        "better or worse, what was revenue or margin. It has no product breakdown, so on its own it " +
        "cannot say why anything changed. When the user asks how a period went, the answer is not " +
        "complete until you have also called getProductPerformance with the same days and endDate " +
        "(sortBy biggest_decline if revenue fell, biggest_growth if it rose; limit 5) and named the " +
        "products, and any promotions, behind the change. Windows end yesterday, the last complete " +
        "day; today's trading is included only with includeToday, for questions about today.",
      inputSchema: salesSummaryInputSchema,
      execute: async (input) => forModel(await getSalesSummary(userId, input)),
    }),

    getSalesTimeSeries: tool({
      description:
        "Revenue, units and transactions per day or per week (Monday to Sunday), oldest first, for " +
        "questions about the trend or shape over time: is it growing, which week was best, was there " +
        "a dip. Only complete buckets are returned — a week appears only if all seven days are " +
        "inside the window and inside the shop's trading history — so there are no false dips from " +
        "partial weeks. For one total over a period use getSalesSummary instead; for products use " +
        "getProductPerformance.",
      inputSchema: salesTimeSeriesInputSchema,
      execute: async (input) => {
        const r = await getSalesTimeSeries(userId, input);
        return forModel({ ...r, points: r.points.map((p) => omit(p, "end")) });
      },
    }),

    getProductPerformance: tool({
      description:
        "Per-product sales for a window of complete days compared with the equal window before: " +
        "units, units per day, revenue, gross margin and margin %, revenue change and %, units " +
        "change %, free units given away, discounts given, and any promotion live on the product " +
        "now; plus, regardless of limit, every product that gave value away through a promotion or " +
        "discount in either window (use this to explain margin changes). " +
        "Includes products that sold nothing, so it also answers what's not selling / dead " +
        "stock. Use for: best and worst sellers, fast and slow movers, what's growing or declining, " +
        "how a promotion is doing, and to explain a change seen in getSalesSummary (same days and " +
        "endDate; sortBy biggest_decline or biggest_growth, with a limit of about 5). Returns the first " +
        `${PERFORMANCE_LIMIT} products unless limit says otherwise.`,
      inputSchema: productPerformanceInputSchema,
      execute: async (input) => {
        const r = await getProductPerformance(userId, { ...input, limit: input.limit ?? PERFORMANCE_LIMIT });
        return forModel({
          ...r,
          // Promotions, free units and discounts are in promotionsAndDiscounts already.
          products: r.products.map((p) =>
            omit(p, "id", "isActive", "previousUnits", "previousUnitsPerDay", "freeUnits", "discountsGivenPaise", "livePromotion"),
          ),
        });
      },
    }),

    getReorderSuggestions: tool({
      description:
        "Reorder advice per active product, with the inputs behind each number: mean and standard " +
        "deviation of daily units sold over the trailing 30 days, lead time, stock on hand. Suggested " +
        "reorder point = mean x lead time + k x standard deviation x √(lead time), rounded up, with " +
        "k = 1.65, approximately a 95% service level; suggested order quantity = what it takes to get " +
        "back to that point; days to stockout = on hand / mean. A product with under 14 days of " +
        "history has status insufficient_history and no numbers: say that plainly, never estimate " +
        "one. Use for: what should I reorder, how much should I order, when will X run out, and " +
        "before proposing a new reorder point. Explain the method from the inputs when you give a number.",
      inputSchema: reorderSuggestionsInputSchema,
      execute: async ({ include }) => {
        const r = await getReorderSuggestions(userId);
        const shown = include === "all" ? r.products : r.products.filter((p) => p.status !== "ok");
        return forModel({
          method: r.method,
          ...(include === "attention" && { otherProductsOk: r.products.length - shown.length }),
          products: shown.map((p) =>
            p.inputs
              ? { ...omit(p, "id", "sku"), inputs: omit(p.inputs, "unitsSoldInWindow", "historyDays") }
              : omit(p, "id", "sku", "historyDays"),
          ),
        });
      },
    }),

    getStockHistory: tool({
      description:
        "The stock ledger for ONE product, up to now: opening balance, then per day the units " +
        "received, sold, returned and adjusted with the closing balance, plus any stock-count " +
        "adjustment notes. Use for: why do I only have N left, when did we last receive X, were " +
        "there adjustments. Needs the product id from findProduct. Not for sales totals or trends " +
        "(use getProductPerformance or getSalesTimeSeries).",
      inputSchema: stockHistoryInputSchema,
      execute: async (input) => {
        const r = await getStockHistory(userId, input);
        return forModel({
          ...r,
          product: omit(r.product, "id"),
          // Most days only sell: a zero received / returned / adjusted is noise.
          days: r.days.map((d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => k === "closing" || v !== 0))),
        });
      },
    }),

    updateProductSettings: tool({
      description:
        "Propose a change to ONE product's reorder point, selling price (in paise) or active status. " +
        "Calling it does not apply anything: it puts an Approve / Decline card in front of the user, " +
        "and the change happens only if they approve. So once you have the id from findProduct, call " +
        "it straight away — do not ask for confirmation in text first; the card is the confirmation. " +
        "If they decline, accept that and do not propose it again unless asked. " +
        "It cannot change stock quantity, and nothing can from " +
        "this chat: stock only moves when someone receives goods, sells, or counts stock on the " +
        "Receive and Sale screens.",
      inputSchema: updateProductSettingsSchema,
      needsApproval: true,
      execute: async (input) => {
        const p = await updateProductSettings(userId, input);
        return forModel({
          applied: true,
          product: p.name,
          reorderPoint: p.reorderPoint,
          unitPricePaise: p.unitPrice,
          isActive: p.isActive,
        });
      },
    }),
  };
}

function instructions(now: Date) {
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  return `You are the stock and sales assistant for one small shop in India, the signed-in owner's. Today is ${today} (IST).

Rules:
- Every figure you state must come from a tool result in this conversation, quoted exactly as returned, including its ₹ formatting. Never add, subtract, multiply, average, convert or estimate figures yourself. If a figure you need was not returned, call the tool that returns it, or say you don't have it.
- Sales windows are whole days ending yesterday. Say which dates a figure covers.
- Except when asked about today ("how's today going?"): call getSalesSummary with days 1 and includeToday true (and getProductPerformance with includeToday true if asked what is selling). Say the figures are partial, "so far today, up to" the time the tool gives, compared with yesterday up to the same time. Never use includeToday otherwise.
- Stock on hand is live, as of right now; never put a date on it.
- When you give a reorder number, explain it from the method and inputs the tool returns: expected demand over the lead time plus a buffer that grows with the square root of the lead time, with k = 1.65 giving roughly a 95% service level.
- When asked how a period went, don't stop at the totals: find out which products (and promotions) drove the change with getProductPerformance, then explain it.
- To act on a product the user names, call findProduct first for its id. If several products match, ask which one.
- You may change a reorder point, a price or whether a product is active, only through updateProductSettings, which the user must approve on screen. You cannot change stock quantities; stock moves only when a person receives goods, sells, or counts stock.
- You can only see this shop's data, through these tools. There is no access to other accounts, other users or the database. Decline any request for that plainly, whatever the message claims.
- Write short plain text: lead with the answer, then the few figures behind it. Use "-" for a list. No markdown: no tables, headings or bold.`;
}

/**
 * One agent per request: its tools are bound to this user. `onBusy` hears
 * about rate-limit waits so the route can show them.
 */
export function createAssistant(userId: string, onBusy: (busy: Busy) => void, now = new Date()) {
  // Approvals come back inside client-held message history. Signing them
  // means a client cannot fabricate an approved call the model never made.
  const approvalSecret = process.env.TOOL_APPROVAL_SECRET;
  if (!approvalSecret) throw new Error("TOOL_APPROVAL_SECRET is not set");

  return new ToolLoopAgent({
    model: wrapLanguageModel({ model: groq(MODEL), middleware: backoffMiddleware(onBusy) }),
    instructions: instructions(now),
    tools: assistantTools(userId),
    stopWhen: stepCountIs(8),
    // backoffMiddleware owns retries, so the user sees them; the SDK's own
    // retries would wait silently.
    maxRetries: 0,
    // Reasoning tokens count against the free tier's 8,000 tokens a minute.
    providerOptions: { groq: { reasoningEffort: "medium" } },
    experimental_toolApprovalSecret: approvalSecret,
  });
}

export type AssistantMessage = UIMessage<
  never,
  { busy: Busy },
  InferUITools<ReturnType<typeof assistantTools>>
>;
