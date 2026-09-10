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
  .extend({ productId: z.uuid() });

export const receiveGoodsInputSchema = z.object({
  supplierId: z.uuid().optional(),
  // The receiving screen types a supplier name; the service finds or creates
  // the supplier row. Ignored when supplierId is given.
  supplierName: z.string().trim().min(1).max(200).optional(),
  reference: z.string().trim().max(200).optional(),
  receivedAt: z.coerce.date().optional(),
  source: z.enum(["manual", "upload"]).default("manual"),
  lines: z.array(receiptLineInputSchema).min(1, "a receipt needs at least one line"),
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

/** Settings the assistant is allowed to change. Never quantity — see section 8. */
export const updateProductSettingsSchema = z.object({
  productId: z.uuid(),
  reorderPoint: z.number().int().min(0).optional(),
  unitPrice: z.number().int().min(0).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export type ProductInput = z.infer<typeof productInputSchema>;
export type ReceiveGoodsInput = z.input<typeof receiveGoodsInputSchema>;
export type RecordSaleInput = z.input<typeof recordSaleInputSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockInputSchema>;
export type UpdateProductSettingsInput = z.infer<typeof updateProductSettingsSchema>;
