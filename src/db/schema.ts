/**
 * DESIGN.md section 6, transcribed. Money is `integer`, in paise — no floats
 * anywhere near a price or a cost (section 5, rule 7). Every table carries
 * `user_id`. Timestamps are timestamptz.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth-schema";

const userId = () =>
  uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    name: text("name").notNull(),
    sku: text("sku").notNull(),
    category: text("category"),
    unitPrice: integer("unit_price").notNull(), // paise
    averageCost: integer("average_cost").notNull().default(0),
    quantityOnHand: integer("quantity_on_hand").notNull().default(0),
    reorderPoint: integer("reorder_point").notNull().default(0),
    leadTimeDays: integer("lead_time_days").notNull().default(7),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Per user, never global: two shops may both stock SKU "MUG-01".
    unique("products_user_sku_key").on(t.userId, t.sku),
    index("products_user_active_idx").on(t.userId, t.isActive),
    // Trigram index for the upload matcher in section 3 — similarity is scored
    // in Postgres, never by pulling the catalogue into Node.
    index("products_name_trgm_idx").using("gin", sql`${t.name} gin_trgm_ops`),
    check("products_unit_price_check", sql`${t.unitPrice} >= 0`),
    check("products_average_cost_check", sql`${t.averageCost} >= 0`),
    // Section 5, rule 5: negative stock is impossible via *any* path, not just
    // the ones we remembered to guard.
    check("products_quantity_on_hand_check", sql`${t.quantityOnHand} >= 0`),
    check("products_reorder_point_check", sql`${t.reorderPoint} >= 0`),
    check("products_lead_time_days_check", sql`${t.leadTimeDays} >= 0`),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("suppliers_user_name_key").on(t.userId, t.name)],
);

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    reference: text("reference"), // supplier's delivery note number
    status: text("status").notNull().default("draft"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("receipts_user_status_idx").on(t.userId, t.status),
    check("receipts_status_check", sql`${t.status} IN ('draft','confirmed')`),
    check("receipts_source_check", sql`${t.source} IN ('manual','upload')`),
  ],
);

export const receiptLines = pgTable(
  "receipt_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "cascade" }),
    // Null while unresolved in a draft: the extractor read a line it could not
    // match to a product yet.
    productId: uuid("product_id").references(() => products.id),
    rawText: text("raw_text"), // what the document said
    quantity: integer("quantity").notNull(),
    // Unit cost lives here, not on the product: the same item costs 80 rupees
    // in March and 95 in July, and this is what feeds the weighted average.
    unitCost: integer("unit_cost").notNull(),
  },
  (t) => [
    check("receipt_lines_quantity_check", sql`${t.quantity} > 0`),
    check("receipt_lines_unit_cost_check", sql`${t.unitCost} >= 0`),
  ],
);

// Learned matches, so the second upload from the same supplier is easier.
export const supplierAliases = pgTable(
  "supplier_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    rawText: text("raw_text").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
  },
  (t) => [unique("supplier_aliases_key").on(t.userId, t.supplierId, t.rawText)],
);

export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    percent: integer("percent"),
    buyQty: integer("buy_qty"),
    getQty: integer("get_qty"),
    // Explicit ordering. Postgres guarantees no row order without ORDER BY, and
    // nondeterministic pricing makes tests flap.
    priority: integer("priority").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    index("promotions_lookup_idx").on(t.userId, t.productId, t.isActive),
    check(
      "promotions_type_check",
      sql`${t.type} IN ('percent_off','buy_x_get_y')`,
    ),
    check("promotions_percent_check", sql`${t.percent} BETWEEN 1 AND 100`),
    check("promotions_buy_qty_check", sql`${t.buyQty} > 0`),
    check("promotions_get_qty_check", sql`${t.getQty} > 0`),
    // A row cannot be half a rule: percent_off needs a percent, buy_x_get_y
    // needs both quantities.
    check(
      "promotions_shape_check",
      sql`(${t.type} = 'percent_off' AND ${t.percent} IS NOT NULL) OR (${t.type} = 'buy_x_get_y' AND ${t.buyQty} IS NOT NULL AND ${t.getQty} IS NOT NULL)`,
    ),
  ],
);

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    subtotal: integer("subtotal").notNull(), // before discounts
    discountTotal: integer("discount_total").notNull().default(0),
    total: integer("total").notNull(),
    costTotal: integer("cost_total").notNull(), // sum of stamped average costs
    // Section 5, rule 3: a double submission violates this unique constraint,
    // which the service layer catches and turns into "here is the sale you
    // already made".
    idempotencyKey: text("idempotency_key").notNull(),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sales_user_idempotency_key").on(t.userId, t.idempotencyKey),
    index("sales_user_time_idx").on(t.userId, t.soldAt.desc()),
  ],
);

export const saleLines = pgTable(
  "sale_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull(),
    listPrice: integer("list_price").notNull(), // what the product said at the time
    // What was actually charged, 0 for free units. Historical sales are never
    // repriced by joining to today's price list.
    chargedPrice: integer("charged_price").notNull(),
    unitCost: integer("unit_cost").notNull(), // average cost stamped at sale time
    // A whole-line amount, not per unit. Holds the line's share of a sale-level
    // discount and any percent-off remainder that does not divide into a whole
    // per-unit price. Line revenue = quantity * charged_price - discount_amount;
    // line cost = quantity * unit_cost.
    discountAmount: integer("discount_amount").notNull().default(0),
    promotionId: uuid("promotion_id").references(() => promotions.id), // why it was discounted
    isFreeUnit: boolean("is_free_unit").notNull().default(false),
  },
  (t) => [
    index("sale_lines_product_idx").on(t.productId),
    check("sale_lines_quantity_check", sql`${t.quantity} > 0`),
    check("sale_lines_discount_amount_check", sql`${t.discountAmount} >= 0`),
  ],
);

// Section 1: stock is an append-only ledger. Quantity on hand is the sum of it.
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: userId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(), // signed
    reason: text("reason").notNull(),
    referenceId: uuid("reference_id"), // the sale or receipt that caused it
    note: text("note"), // required by the service layer for adjustments
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("movements_product_time_idx").on(t.productId, t.createdAt.desc()),
    index("movements_user_time_idx").on(t.userId, t.createdAt.desc()),
    // A zero-quantity movement is a bug, not a no-op.
    check("stock_movements_quantity_check", sql`${t.quantity} <> 0`),
    check(
      "stock_movements_reason_check",
      sql`${t.reason} IN ('receipt','sale','return','adjustment')`,
    ),
  ],
);

export const productRelations = relations(products, ({ many }) => ({
  movements: many(stockMovements),
  promotions: many(promotions),
  saleLines: many(saleLines),
}));

export const saleRelations = relations(sales, ({ many }) => ({
  lines: many(saleLines),
}));

export const saleLineRelations = relations(saleLines, ({ one }) => ({
  sale: one(sales, { fields: [saleLines.saleId], references: [sales.id] }),
  product: one(products, {
    fields: [saleLines.productId],
    references: [products.id],
  }),
}));

export const receiptRelations = relations(receipts, ({ many, one }) => ({
  lines: many(receiptLines),
  supplier: one(suppliers, {
    fields: [receipts.supplierId],
    references: [suppliers.id],
  }),
}));

export const receiptLineRelations = relations(receiptLines, ({ one }) => ({
  receipt: one(receipts, {
    fields: [receiptLines.receiptId],
    references: [receipts.id],
  }),
  product: one(products, {
    fields: [receiptLines.productId],
    references: [products.id],
  }),
}));
