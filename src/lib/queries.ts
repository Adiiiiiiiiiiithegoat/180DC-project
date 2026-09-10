/**
 * Reads for the pages. Every query filters on user_id in its WHERE clause; a
 * row belonging to another account is never fetched, so it can never leak.
 *
 * Writes live in services.ts. Nothing here changes a row.
 */
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { products, promotions, stockMovements, suppliers } from "../db/schema";

const isUuid = (id: string) => z.uuid().safeParse(id).success;

export async function listProducts(userId: string, { includeInactive = false } = {}) {
  return db
    .select()
    .from(products)
    .where(
      includeInactive
        ? eq(products.userId, userId)
        : and(eq(products.userId, userId), eq(products.isActive, true)),
    )
    .orderBy(asc(products.name));
}

export async function getProduct(userId: string, productId: string) {
  if (!isUuid(productId)) return null;
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.userId, userId)));
  return row ?? null;
}

export async function listPromotionsForProduct(userId: string, productId: string) {
  return db
    .select()
    .from(promotions)
    .where(and(eq(promotions.userId, userId), eq(promotions.productId, productId)))
    .orderBy(asc(promotions.priority), asc(promotions.id));
}

/**
 * Active promotions that have not ended, for the sale screen's preview. The
 * preview runs the same pure priceBasket the server runs at commit, which
 * applies the start/end window itself.
 */
export async function listLivePromotions(userId: string, now: Date) {
  return db
    .select()
    .from(promotions)
    .where(
      and(
        eq(promotions.userId, userId),
        eq(promotions.isActive, true),
        gte(promotions.endsAt, now),
      ),
    );
}

/** The ledger for one product, newest first: "why do I only have three left?" */
export async function listRecentMovements(userId: string, productId: string, limit = 25) {
  return db
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.userId, userId), eq(stockMovements.productId, productId)))
    .orderBy(desc(stockMovements.createdAt))
    .limit(limit);
}

export async function listSuppliers(userId: string) {
  return db
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(eq(suppliers.userId, userId))
    .orderBy(asc(suppliers.name));
}
