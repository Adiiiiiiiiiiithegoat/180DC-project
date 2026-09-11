/**
 * DESIGN.md section 7 — validate once.
 *
 * Zod schemas generated from the tables with drizzle-zod, so column types come
 * from the schema rather than being retyped by hand. The service layer, the
 * REST routes, the forms and the AI tools all import from here: a rejected
 * input is rejected identically whichever door it came through.
 *
 * `userId` appears in NONE of these schemas. It comes from the session at the
 * top of the request and is passed to the service function as its own
 * argument. It is never accepted from a caller, so there is nothing for a
 * request body — or a prompt-injected tool call — to aim at.
 */
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import {
  products,
  promotions,
  receiptLines,
  stockMovements,
  suppliers,
} from "../db/schema";

/** Columns the caller never sets: identity, ownership, and derived state. */
const SERVER_OWNED = {
  id: true,
  userId: true,
  createdAt: true,
} as const;

export const productInputSchema = createInsertSchema(products, {
  name: (s) => s.trim().min(1, "name is required"),
  sku: (s) => s.trim().min(1, "sku is required"),
  unitPrice: (s) => s.int().min(0),
  reorderPoint: (s) => s.int().min(0),
  leadTimeDays: (s) => s.int().min(0),
}).omit({
  ...SERVER_OWNED,
  // Both are ledger-derived. Stock moves through receiveGoods / recordSale /
  // adjustStock, and average cost is recalculated on receipt. Neither is ever
  // set directly by a form or a tool.
  averageCost: true,
  quantityOnHand: true,
});

/** Every product field is optional on update; quantity and average cost stay excluded. */
export const productUpdateSchema = productInputSchema.partial();

export const supplierInputSchema = createInsertSchema(suppliers, {
  name: (s) => s.trim().min(1, "name is required"),
}).omit(SERVER_OWNED);

export const promotionInputSchema = createInsertSchema(promotions, {
  productId: () => z.uuid(),
  percent: (s) => s.int().min(1).max(100),
  buyQty: (s) => s.int().positive(),
  getQty: (s) => s.int().positive(),
  priority: (s) => s.int(),
  // JSON has no date type; forms and tools send ISO strings.
  startsAt: () => z.coerce.date(),
  endsAt: () => z.coerce.date(),
})
  .omit({ id: true, userId: true })
  // Mirrors promotions_shape_check in the database. The constraint is the real
  // guarantee; this exists so the user gets a field error instead of a 500.
  .refine(
    (p) =>
      p.type === "percent_off"
        ? p.percent != null
        : p.buyQty != null && p.getQty != null,
    { message: "percent_off needs a percent; buy_x_get_y needs buy and get quantities" },
  )
  .refine((p) => p.endsAt > p.startsAt, {
    message: "ends_at must be after starts_at",
  });

export const promotionActiveSchema = z.object({ isActive: z.boolean() });

/**
 * A receipt line as the caller supplies it. Derived from the table, then
 * narrowed: `product_id` is nullable in the schema because an uploaded draft
 * may hold a line nobody has matched to a product yet, but confirming a
 * receipt requires one.
 */
const receiptLineInputSchema = createInsertSchema(receiptLines, {
  quantity: (s) => s.int().positive(),
  unitCost: (s) => s.int().min(0),
})
  .pick({ quantity: true, unitCost: true })
  .extend({
    productId: z.uuid(),
    // An uploaded line's text as the document printed it. Stored on the line,
    // and learned as a supplier alias so the same text matches itself next time.
    rawText: z.string().trim().min(1).max(300).optional(),
  });

export const receiveGoodsInputSchema = z.object({
  supplierId: z.uuid().optional(),
  // The receiving screen types a supplier name; the service finds or creates
  // the supplier row. Ignored when supplierId is given.
  supplierName: z.string().trim().min(1).max(200).optional(),
  reference: z.string().trim().max(200).optional(),
  receivedAt: z.coerce.date().optional(),
  source: z.enum(["manual", "upload"]).default("manual"),
  lines: z.array(receiptLineInputSchema).min(1, "a receipt needs at least one line"),
  // Confirming an upload whose document total disagrees with its lines needs
  // this said out loud (section 3): a mismatch is never silently accepted.
  acceptTotalMismatch: z.boolean().default(false),
  // The same for a supplier + reference that has been received before.
  acceptDuplicate: z.boolean().default(false),
  // Section 5, rule 3, as for sales: one key per receiving form.
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const recordSaleInputSchema = z.object({
  // Section 5, rule 3. The client generates this once per basket, so a double
  // submission carries the same key and collides with sales_user_idempotency_key.
  idempotencyKey: z.string().trim().min(1).max(200),
  saleDiscount: z.number().int().min(0).default(0),
  // Section 5, rule 2: the total the client showed. When present and the
  // server's own pricing disagrees, the sale is refused with price_changed and
  // nothing is written.
  expectedTotal: z.number().int().min(0).optional(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.number().int().positive(),
        // Defaults from the product when omitted; the sale screen allows the
        // cashier to edit it inline.
        unitPrice: z.number().int().min(0).optional(),
      }),
    )
    .min(1, "a sale needs at least one line"),
});

export const adjustStockInputSchema = createInsertSchema(stockMovements, {
  quantity: (s) => s.int(),
})
  .pick({ quantity: true })
  .extend({
    productId: z.uuid(),
    /** Signed. Positive is a count-up, negative a count-down. */
    delta: z.number().int().refine((d) => d !== 0, {
      message: "delta must not be zero — a movement of nothing is a bug, not a no-op",
    }),
    // Mandatory. An adjustment is a human overriding the ledger; the reason it
    // happened is the only thing that makes it auditable later.
    note: z.string().trim().min(1, "a note is mandatory for an adjustment"),
  })
  .omit({ quantity: true });

/**
 * Settings the assistant is allowed to change: reorder point, price, active
 * status. Never quantity or average cost — those are the ledger's (section 8).
 * `.strict()` so a call carrying any other field is refused outright rather
 * than having the field silently dropped.
 */
export const updateProductSettingsSchema = z
  .object({
    productId: z.uuid().describe("The product's id, from findProduct."),
    reorderPoint: z.number().int().min(0).max(100_000).optional()
      .describe("New reorder point, in units."),
    unitPrice: z.number().int().min(0).max(100_000_000).optional()
      .describe("New selling price in PAISE (₹1 = 100 paise, so ₹250 is 25000)."),
    isActive: z.boolean().optional()
      .describe("false hides the product from the sale screen; true restores it."),
  })
  .strict()
  .refine((s) => s.reorderPoint !== undefined || s.unitPrice !== undefined || s.isActive !== undefined, {
    message: "change at least one of reorderPoint, unitPrice, isActive",
  });

// ---------------------------------------------------------------------------
// Analytics inputs (DESIGN.md section 8). These are the tool schemas the model
// sees, so every field is described and every range is tight: an open model
// picks arguments far more reliably from a narrow menu than from free text.
// No schema has a user field; the account is the session's, always.
// ---------------------------------------------------------------------------

const days = (fallback: number) =>
  z.number().int().min(1).max(365).default(fallback)
    .describe(`Length of the window in whole days. Default ${fallback}.`);

// Every window is made of complete IST days: it ends yesterday unless endDate
// says earlier, and a later endDate is pulled back to yesterday (section 9).
const endDate = z.iso.date().optional()
  .describe("Last day of the window, YYYY-MM-DD, inclusive. Omit to end yesterday, the last complete day.");

// The one way today's unfinished trading gets in, and only when asked for.
const includeToday = z.boolean().default(false)
  .describe("Only for questions about today: the window ends now, not yesterday. PARTIAL figures.");

export const findProductInputSchema = z.object({
  query: z.string().trim().min(1).max(100)
    .describe("A product name, part of one, or a SKU, as it was asked for, e.g. \"pens\" or \"STN-PEN-10\"."),
});

export const inventoryStatusInputSchema = z.object({
  filter: z.enum(["all", "low", "out"]).default("all")
    .describe("low: at or below reorder point (includes out of stock). out: zero on hand. all: every active product."),
});

export const salesSummaryInputSchema = z.object({
  days: days(30),
  endDate,
  includeToday,
  compareToPrevious: z.boolean().default(true)
    .describe("Also return the same-length window immediately before, and the change. Default true."),
});

export const salesTimeSeriesInputSchema = z.object({
  granularity: z.enum(["day", "week"]).default("week"),
  days: days(90),
  endDate,
});

export const productPerformanceInputSchema = z.object({
  days: days(30),
  endDate,
  includeToday,
  sortBy: z.enum(["revenue", "units", "biggest_decline", "biggest_growth", "speeding_up", "slowing_down"]).default("revenue")
    .describe("biggest_decline / biggest_growth: by revenue change against the previous window. " +
      "speeding_up / slowing_down: by change in units sold (fast and slow movers)."),
  limit: z.number().int().min(1).max(50).optional()
    .describe("Return only the first N products after sorting. The assistant's default is 10; pass 50 for " +
      "every product, e.g. to find what isn't selling."),
});

export const reorderSuggestionsInputSchema = z.object({
  include: z.enum(["attention", "all"]).default("attention")
    .describe("attention: only products to reorder now or without enough history (the default). " +
      "all: every active product, for a question about one particular product."),
});

export const stockHistoryInputSchema = z.object({
  productId: z.uuid().describe("The product's id, from findProduct."),
  days: days(30),
});

export type ProductInput = z.infer<typeof productInputSchema>;
export type ReceiveGoodsInput = z.input<typeof receiveGoodsInputSchema>;
export type RecordSaleInput = z.input<typeof recordSaleInputSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockInputSchema>;
export type UpdateProductSettingsInput = z.infer<typeof updateProductSettingsSchema>;
export type SalesSummaryInput = z.input<typeof salesSummaryInputSchema>;
export type SalesTimeSeriesInput = z.input<typeof salesTimeSeriesInputSchema>;
export type ProductPerformanceInput = z.input<typeof productPerformanceInputSchema>;
