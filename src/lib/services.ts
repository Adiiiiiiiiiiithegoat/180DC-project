/**
 * DESIGN.md section 7 — one service layer, three front doors.
 *
 * recordSale is written once, owning validation and the transaction. The REST
 * route calls it, the AI tool calls it, the importer calls it. None of them
 * touch the database directly.
 *
 * `userId` is always the first argument and always comes from the session at
 * the top of the request. Every query below filters on it in the WHERE clause,
 * not in application code after the fact.
 *
 * Nothing here issues an UPDATE or a DELETE against `sales`, `sale_lines` or
 * `stock_movements`. They are append-only (section 5, rule 6); corrections are
 * reversing movements. The stock-moving functions update only `products`,
 * whose `quantity_on_hand` is a concurrency control point rather than a cache
 * (section 1).
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  products,
  promotions,
  receiptLines,
  receipts,
  saleLines,
  sales,
  stockMovements,
  suppliers,
} from "../db/schema";
import { PricingError, priceBasket, type PriceBasketResult, type Promotion } from "./pricing";
import { isUniqueViolation } from "./pg-error";
import {
  adjustStockInputSchema,
  productInputSchema,
  productUpdateSchema,
  promotionActiveSchema,
  promotionInputSchema,
  receiveGoodsInputSchema,
  recordSaleInputSchema,
  updateProductSettingsSchema,
} from "./validation";

/**
 * The query builder as seen inside a transaction. Drizzle's transaction object
 * is not a NodePgDatabase (it has no `$client`), so helpers that must run
 * inside the caller's transaction take this union rather than being cast.
 */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;

export type ServiceErrorCode =
  | "insufficient_stock"
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "price_changed";

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * Options only trusted internal code may pass. They are deliberately not part
 * of any Zod schema, so no request body and no tool call can set them.
 */
export type InternalOptions = {
  /**
   * When the event is recorded as having happened. Defaults to now. It exists
   * for the seed script, which replays 90 days of history through these same
   * functions rather than around them. A caller who could choose this could
   * price a sale inside a promotion that has already ended.
   */
  at?: Date;
};

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Confirms every product id belongs to this user, inside the transaction.
 *
 * This is the ownership check, and it is a WHERE clause rather than a filter
 * applied to results afterwards: a product belonging to someone else does not
 * come back at all, so there is no row to accidentally use.
 */
async function loadOwnedProducts(
  tx: Executor,
  userId: string,
  productIds: string[],
) {
  const rows = await tx
    .select()
    .from(products)
    .where(and(eq(products.userId, userId), inArray(products.id, productIds)));

  if (rows.length !== productIds.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = productIds.filter((id) => !found.has(id));
    throw new ServiceError(
      "not_found",
      `no such product for this account: ${missing.join(", ")}`,
    );
  }
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * DESIGN.md section 3. One transaction: the receipt, its lines, the `receipt`
 * movements, the incremented quantity, and the recalculated weighted average.
 */
export async function receiveGoods(
  userId: string,
  rawInput: unknown,
  options: InternalOptions = {},
) {
  const input = receiveGoodsInputSchema.parse(rawInput);
  const at = options.at ?? new Date();

  return db.transaction(async (tx) => {
    const productIds = [...new Set(input.lines.map((l) => l.productId))];
    await loadOwnedProducts(tx, userId, productIds);

    let supplierId: string | null = null;
    if (input.supplierId) {
      // A supplier id from the caller is checked for ownership like a product
      // id: the foreign key alone would happily accept someone else's supplier.
      const [owned] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.userId, userId)));
      if (!owned) throw new ServiceError("not_found", "no such supplier for this account");
      supplierId = owned.id;
    } else if (input.supplierName) {
      // Find-or-create by (user_id, name). The no-op update is what makes
      // RETURNING hand back the existing row on conflict.
      const [supplier] = await tx
        .insert(suppliers)
        .values({ userId, name: input.supplierName })
        .onConflictDoUpdate({
          target: [suppliers.userId, suppliers.name],
          set: { name: sql`excluded.name` },
        })
        .returning({ id: suppliers.id });
      supplierId = supplier.id;
    }

    const [receipt] = await tx
      .insert(receipts)
      .values({
        userId,
        supplierId,
        reference: input.reference ?? null,
        // Confirming a draft runs this same code path; a draft that has not
        // been confirmed never reaches here, because a draft moves no stock.
        status: "confirmed",
        receivedAt: input.receivedAt ?? at,
        confirmedAt: at,
        source: input.source,
        createdAt: at,
      })
      .returning();

    await tx.insert(receiptLines).values(
      input.lines.map((line) => ({
        receiptId: receipt.id,
        productId: line.productId,
        quantity: line.quantity,
        unitCost: line.unitCost,
      })),
    );

    // One movement per line, positive: goods arrived.
    await tx.insert(stockMovements).values(
      input.lines.map((line) => ({
        userId,
        productId: line.productId,
        quantity: line.quantity,
        reason: "receipt",
        referenceId: receipt.id,
        createdAt: at,
      })),
    );

    // Row locks in one global order (product id) so two concurrent receipts, or
    // a receipt racing a sale, can never wait on each other in a cycle. The
    // sort is stable, so two lines for the same product keep their order.
    const ordered = [...input.lines].sort((a, b) => byId(a.productId, b.productId));

    for (const line of ordered) {
      /**
       * Weighted average cost, DESIGN.md section 2:
       *
       *   new_average = (existing_qty * existing_average + received_qty * received_cost)
       *                 / (existing_qty + received_qty)
       *
       * Done in one UPDATE so there is no read-then-write window, and in
       * `numeric` rather than floating point so the arithmetic is exact before
       * it is rounded back to whole paise. Both SET expressions see the OLD
       * row, which is what makes the average use the pre-receipt quantity.
       */
      const updated = await tx
        .update(products)
        .set({
          averageCost: sql`ROUND(
            ((${products.quantityOnHand}::numeric * ${products.averageCost}::numeric)
              + (${line.quantity}::numeric * ${line.unitCost}::numeric))
            / (${products.quantityOnHand}::numeric + ${line.quantity}::numeric)
          )::integer`,
          quantityOnHand: sql`${products.quantityOnHand} + ${line.quantity}::integer`,
        })
        .where(and(eq(products.id, line.productId), eq(products.userId, userId)))
        .returning({ id: products.id });

      if (updated.length !== 1) {
        throw new ServiceError("not_found", `product ${line.productId} vanished mid-receipt`);
      }
    }

    return receipt;
  });
}

export type RecordSaleResult = {
  id: string;
  subtotal: number;
  discountTotal: number;
  total: number;
  costTotal: number;
  soldAt: Date;
  /** True when this key had already been used and the existing sale is returned. */
  idempotentReplay: boolean;
};

/**
 * DESIGN.md section 4 — the sale as a transaction. All of it or none of it.
 */
export async function recordSale(
  userId: string,
  rawInput: unknown,
  options: InternalOptions = {},
): Promise<RecordSaleResult> {
  const input = recordSaleInputSchema.parse(rawInput);

  // The clock is read here, once, and passed into the pure pricer. It is never
  // accepted from a request: see InternalOptions.
  const now = options.at ?? new Date();

  try {
    return await db.transaction(async (tx) => {
      const productIds = [...new Set(input.lines.map((l) => l.productId))];
      const owned = await loadOwnedProducts(tx, userId, productIds);

      const inactive = [...owned.values()].filter((p) => !p.isActive);
      if (inactive.length > 0) {
        throw new ServiceError(
          "invalid_input",
          `cannot sell a deactivated product: ${inactive.map((p) => p.name).join(", ")}`,
        );
      }

      const promoRows = await tx
        .select()
        .from(promotions)
        .where(
          and(
            eq(promotions.userId, userId),
            inArray(promotions.productId, productIds),
            eq(promotions.isActive, true),
          ),
        );

      // Section 5, rule 2: the server prices at commit, inside the transaction.
      // Whatever the client displayed was a preview. A line without a unitPrice
      // is priced from the product as it is NOW, not as it was when the page
      // loaded.
      let priced: PriceBasketResult;
      try {
        priced = priceBasket(
          input.lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: l.unitPrice ?? owned.get(l.productId)!.unitPrice,
          })),
          promoRows as Promotion[],
          now,
          input.saleDiscount ?? 0,
        );
      } catch (e) {
        // A basket that cannot be priced as asked (a sale discount bigger than
        // what is left to pay) is the caller's mistake: 400, with the reason.
        if (e instanceof PricingError) throw new ServiceError("invalid_input", e.message);
        throw e;
      }

      // "A mismatch stops and re-displays." If the client says what total it
      // showed and the server disagrees — a price edited or a promotion ended
      // since the page loaded — nothing is written and the server's pricing
      // goes back so the screen can show the customer the real number.
      if (input.expectedTotal !== undefined && input.expectedTotal !== priced.total) {
        throw new ServiceError(
          "price_changed",
          `the total is now ${priced.total}, not ${input.expectedTotal}`,
          { priced },
        );
      }

      // Cost is stamped from the product's average at this moment, so
      // historical margin never changes when costs later move (section 2).
      // Multiplied by the line quantity: a free-unit line is zero revenue but
      // full cost, so leaving the quantity out understates cost of goods.
      const costTotal = priced.lines.reduce(
        (sum, l) => sum + l.quantity * owned.get(l.productId)!.averageCost,
        0,
      );

      const [sale] = await tx
        .insert(sales)
        .values({
          userId,
          subtotal: priced.subtotal,
          discountTotal: priced.discountTotal,
          total: priced.total,
          costTotal,
          idempotencyKey: input.idempotencyKey,
          soldAt: now,
        })
        .returning();

      await tx.insert(saleLines).values(
        priced.lines.map((line) => ({
          saleId: sale.id,
          productId: line.productId,
          quantity: line.quantity,
          listPrice: line.listPrice,
          chargedPrice: line.chargedPrice,
          discountAmount: line.discountAmount,
          unitCost: owned.get(line.productId)!.averageCost,
          promotionId: line.promotionId,
          isFreeUnit: line.isFreeUnit,
        })),
      );

      // One movement per line, carrying that line's signed quantity — the same
      // rule as receiving. Free-unit lines included: a BOGO free unit is zero
      // revenue, one unit of stock, full cost, and omitting its movement would
      // leave a phantom item on the shelf (section 4).
      await tx.insert(stockMovements).values(
        priced.lines.map((line) => ({
          userId,
          productId: line.productId,
          quantity: -line.quantity,
          reason: "sale",
          referenceId: sale.id,
          createdAt: now,
        })),
      );

      const unitsPerProduct = new Map<string, number>();
      for (const line of priced.lines) {
        unitsPerProduct.set(
          line.productId,
          (unitsPerProduct.get(line.productId) ?? 0) + line.quantity,
        );
      }

      // Section 5, rule 1. Never read-then-write. The conditional UPDATE takes
      // a row lock and re-evaluates `quantity_on_hand >= n` after acquiring it,
      // so a racing sale that got there first turns this into zero rows
      // affected — which is the correct stockout signal under READ COMMITTED.
      //
      // Products are locked in id order, never basket order. Basket order lets
      // a sale of [A, B] and a concurrent sale of [B, A] each hold one lock and
      // wait for the other; Postgres breaks the cycle by killing one of them
      // (40P01) and a valid sale fails. One global order makes a cycle
      // impossible. Test 3b in services.test.ts reproduces the deadlock.
      for (const productId of [...unitsPerProduct.keys()].sort(byId)) {
        const units = unitsPerProduct.get(productId)!;
        const decremented = await tx
          .update(products)
          .set({ quantityOnHand: sql`${products.quantityOnHand} - ${units}::integer` })
          .where(
            and(
              eq(products.id, productId),
              eq(products.userId, userId),
              gte(products.quantityOnHand, units),
            ),
          )
          .returning({ id: products.id });

        if (decremented.length !== 1) {
          // Rolls back everything above: the sale, its lines, its movements.
          throw new ServiceError(
            "insufficient_stock",
            `not enough ${owned.get(productId)!.name} in stock: needed ${units}`,
            { productId },
          );
        }
      }

      return { ...sale, idempotentReplay: false };
    });
  } catch (e) {
    // Section 5, rule 3: a double submission carries the same key and violates
    // the unique constraint. Catch that one violation and return the sale that
    // already exists, rather than making the customer pay twice.
    if (isUniqueViolation(e, "sales_user_idempotency_key")) {
      const [existing] = await db
        .select()
        .from(sales)
        .where(
          and(
            eq(sales.userId, userId),
            eq(sales.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing) return { ...existing, idempotentReplay: true };
    }
    throw e;
  }
}

/**
 * DESIGN.md section 1 — a physical stock count correction. The note is
 * mandatory: an adjustment is a human overriding the ledger, and why it
 * happened is the only thing that makes it auditable later.
 */
export async function adjustStock(userId: string, rawInput: unknown) {
  const input = adjustStockInputSchema.parse(rawInput);

  return db.transaction(async (tx) => {
    await loadOwnedProducts(tx, userId, [input.productId]);

    // Conditional again, for the same reason as the sale: an adjustment must
    // not be able to drive stock negative, and the CHECK constraint would
    // otherwise surface as a 500 rather than a stockout.
    const updated = await tx
      .update(products)
      .set({ quantityOnHand: sql`${products.quantityOnHand} + ${input.delta}::integer` })
      .where(
        and(
          eq(products.id, input.productId),
          eq(products.userId, userId),
          sql`${products.quantityOnHand} + ${input.delta}::integer >= 0`,
        ),
      )
      .returning({ id: products.id, quantityOnHand: products.quantityOnHand });

    if (updated.length !== 1) {
      throw new ServiceError(
        "insufficient_stock",
        `adjustment of ${input.delta} would drive stock below zero`,
      );
    }

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        userId,
        productId: input.productId,
        quantity: input.delta,
        reason: "adjustment",
        note: input.note,
      })
      .returning();

    return { movement, quantityOnHand: updated[0].quantityOnHand };
  });
}

/**
 * DESIGN.md section 5, rule 4 — "a test and a button".
 *
 * Sums the ledger and compares it to the cached quantity. Computed in SQL, and
 * returns only the rows that disagree, so an empty result is the proof.
 */
export async function reconcileStock(userId: string) {
  const rows = await db.execute<{
    id: string;
    name: string;
    quantity_on_hand: number;
    ledger: number;
  }>(sql`
    SELECT p.id,
           p.name,
           p.quantity_on_hand,
           COALESCE(SUM(m.quantity), 0)::integer AS ledger
      FROM ${products} p
      LEFT JOIN ${stockMovements} m
        ON m.product_id = p.id AND m.user_id = p.user_id
     WHERE p.user_id = ${userId}
     GROUP BY p.id, p.name, p.quantity_on_hand
    HAVING p.quantity_on_hand <> COALESCE(SUM(m.quantity), 0)
  `);
  return rows.rows;
}

// ---------------------------------------------------------------------------
// Configuration: products and promotions. These never move stock — quantity
// and average cost are not in either schema — which is why they need no ledger
// entry and no transaction.
// ---------------------------------------------------------------------------

const uuid = z.uuid();

export async function createProduct(userId: string, rawInput: unknown) {
  const input = productInputSchema.parse(rawInput);
  try {
    const [row] = await db
      .insert(products)
      .values({ ...input, userId })
      .returning();
    return row;
  } catch (e) {
    if (isUniqueViolation(e, "products_user_sku_key")) {
      throw new ServiceError("conflict", `a product with SKU ${input.sku} already exists`);
    }
    throw e;
  }
}

/**
 * Name, SKU, category, price, reorder point, lead time, and active status.
 * Deactivating is the delete: `is_active = false`, never a DELETE, because
 * sale lines and movements reference the product forever.
 */
export async function updateProduct(
  userId: string,
  productId: string,
  rawInput: unknown,
) {
  const id = uuid.parse(productId);
  const patch = productUpdateSchema.parse(rawInput);
  if (Object.keys(patch).length === 0) {
    throw new ServiceError("invalid_input", "nothing to update");
  }
  try {
    const [row] = await db
      .update(products)
      .set(patch)
      .where(and(eq(products.id, id), eq(products.userId, userId)))
      .returning();
    if (!row) throw new ServiceError("not_found", "no such product for this account");
    return row;
  } catch (e) {
    if (isUniqueViolation(e, "products_user_sku_key")) {
      throw new ServiceError("conflict", "a product with that SKU already exists");
    }
    throw e;
  }
}

/**
 * The assistant's only write (section 8): reorder point, price, active status.
 * A narrower schema in front of the same updateProduct the product form uses,
 * so the ownership check and the UPDATE are the ones already tested. Quantity
 * is not in the schema; a call that names it is rejected, not trimmed.
 */
export async function updateProductSettings(userId: string, rawInput: unknown) {
  const { productId, ...settings } = updateProductSettingsSchema.parse(rawInput);
  return updateProduct(userId, productId, settings);
}

export async function createPromotion(userId: string, rawInput: unknown) {
  const input = promotionInputSchema.parse(rawInput);
  await loadOwnedProducts(db, userId, [input.productId]);
  const [row] = await db
    .insert(promotions)
    .values({ ...input, userId })
    .returning();
  return row;
}

/** Ending a promotion deactivates its row; the product's own price is never edited. */
export async function setPromotionActive(
  userId: string,
  promotionId: string,
  rawInput: unknown,
) {
  const id = uuid.parse(promotionId);
  const { isActive } = promotionActiveSchema.parse(rawInput);
  const [row] = await db
    .update(promotions)
    .set({ isActive })
    .where(and(eq(promotions.id, id), eq(promotions.userId, userId)))
    .returning();
  if (!row) throw new ServiceError("not_found", "no such promotion for this account");
  return row;
}
