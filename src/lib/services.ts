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
 * reversing movements. The only table this file updates is `products`, whose
 * `quantity_on_hand` is a concurrency control point rather than a cache
 * (section 1).
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  products,
  promotions,
  receiptLines,
  receipts,
  saleLines,
  sales,
  stockMovements,
} from "../db/schema";
import { priceBasket, type Promotion } from "./pricing";
import { isUniqueViolation } from "./pg-error";
import {
  adjustStockInputSchema,
  receiveGoodsInputSchema,
  recordSaleInputSchema,
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
  | "invalid_input";

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

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
export async function receiveGoods(userId: string, rawInput: unknown) {
  const input = receiveGoodsInputSchema.parse(rawInput);
  const now = new Date();

  return db.transaction(async (tx) => {
    const productIds = [...new Set(input.lines.map((l) => l.productId))];
    await loadOwnedProducts(tx, userId, productIds);

    const [receipt] = await tx
      .insert(receipts)
      .values({
        userId,
        supplierId: input.supplierId ?? null,
        reference: input.reference ?? null,
        // Confirming a draft runs this same code path; a draft that has not
        // been confirmed never reaches here, because a draft moves no stock.
        status: "confirmed",
        receivedAt: input.receivedAt ?? now,
        confirmedAt: now,
        source: input.source,
      })
      .returning();

    for (const line of input.lines) {
      await tx.insert(receiptLines).values({
        receiptId: receipt.id,
        productId: line.productId,
        quantity: line.quantity,
        unitCost: line.unitCost,
      });

      await tx.insert(stockMovements).values({
        userId,
        productId: line.productId,
        quantity: line.quantity, // positive: goods arrived
        reason: "receipt",
        referenceId: receipt.id,
      });

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
): Promise<RecordSaleResult> {
  const input = recordSaleInputSchema.parse(rawInput);

  // The clock is read here, once, and passed into the pure pricer. It is never
  // accepted from the caller: a request that could choose `now` could revive an
  // expired promotion.
  const now = new Date();

  try {
    return await db.transaction(async (tx) => {
      const productIds = [...new Set(input.lines.map((l) => l.productId))];
      const byId = await loadOwnedProducts(tx, userId, productIds);

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
      // Whatever the client displayed was a preview.
      const priced = priceBasket(
        input.lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice ?? byId.get(l.productId)!.unitPrice,
        })),
        promoRows as Promotion[],
        now,
        input.saleDiscount ?? 0,
      );

      // Cost is stamped from the product's average at this moment, so
      // historical margin never changes when costs later move (section 2).
      // Multiplied by the line quantity: a free-unit line is zero revenue but
      // full cost, so leaving the quantity out understates cost of goods.
      const costTotal = priced.lines.reduce(
        (sum, l) => sum + l.quantity * byId.get(l.productId)!.averageCost,
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

      for (const line of priced.lines) {
        const product = byId.get(line.productId)!;

        await tx.insert(saleLines).values({
          saleId: sale.id,
          productId: line.productId,
          quantity: line.quantity,
          listPrice: line.listPrice,
          chargedPrice: line.chargedPrice,
          discountAmount: line.discountAmount,
          unitCost: product.averageCost,
          promotionId: line.promotionId,
          isFreeUnit: line.isFreeUnit,
        });

        // One movement per line, carrying that line's signed quantity —
        // the same rule as receiving. Free-unit lines included: a BOGO free
        // unit is zero revenue, one unit of stock, full cost, and omitting its
        // movement would leave a phantom item on the shelf (section 4).
        await tx.insert(stockMovements).values({
          userId,
          productId: line.productId,
          quantity: -line.quantity,
          reason: "sale",
          referenceId: sale.id,
        });
      }

      // Section 5, rule 1. Never read-then-write. The conditional UPDATE takes
      // a row lock and re-evaluates `quantity_on_hand >= n` after acquiring it,
      // so a racing sale that got there first turns this into zero rows
      // affected — which is the correct stockout signal under READ COMMITTED.
      const unitsPerProduct = new Map<string, number>();
      for (const line of priced.lines) {
        unitsPerProduct.set(
          line.productId,
          (unitsPerProduct.get(line.productId) ?? 0) + line.quantity,
        );
      }

      for (const [productId, units] of unitsPerProduct) {
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
            `insufficient stock for product ${productId}: needed ${units}`,
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
