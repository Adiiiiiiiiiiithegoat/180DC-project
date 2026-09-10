/**
 * DESIGN.md section 3 — upload to draft. A draft is a `receipts` row with
 * status 'draft' and the extracted document in `extraction`. It moves no
 * stock: nothing here touches products, receipt lines or stock movements.
 * Confirming one is receiveGoods(userId, lines, { draftId }), the same function
 * manual entry calls.
 *
 * Every query filters on the session user in its WHERE clause.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { receipts } from "../db/schema";
import type { Busy } from "./backoff";
import { extractDocument, prepareDocument, type ExtractedDocument, type ExtractedLine } from "./extraction";
import { ServiceError, normalizeLineText } from "./services";

/**
 * pg_trgm score at or above which a line is matched without asking — provided
 * the runner-up is at least AMBIGUITY_MARGIN behind. Set from the samples:
 * genuine rewordings ("Cold Brew Coffee Can 250 ML" for "Cold Brew Can 250ml")
 * score 0.64 and up; an abbreviation nobody could guess ("FRTN SNFLWR RFND
 * OIL") scores 0.21.
 */
export const AUTO_MATCH = 0.6;
const AMBIGUITY_MARGIN = 0.15;
/** Low enough that the dropdown's suggestions include a weak but right answer. */
const SUGGEST_FROM = 0.15;

const isUuid = (s: string) => z.uuid().safeParse(s).success;

export type Candidate = { productId: string; name: string; sku: string; score: number };

export type LineMatch = {
  productId: string | null;
  /** How it was matched: a learned alias, the SKU printed on the note, or the name. null = unresolved. */
  by: "alias" | "sku" | "name" | null;
  /** 1 for alias and SKU; the trigram score for a name match or the best suggestion. */
  score: number | null;
  candidates: Candidate[];
};

export type DraftLine = ExtractedLine & { match: LineMatch };
export type DraftDocument = Omit<ExtractedDocument, "lines"> & { lines: DraftLine[] };

/**
 * All in Postgres, one statement: for each line, a learned alias from this
 * supplier, else an exact SKU, else the best trigram matches by name
 * (`%` and `<%` are pg_trgm operators the GIN index on products.name serves).
 * The catalogue never comes into Node to be scored.
 */
export async function matchLines(
  userId: string,
  supplierName: string | null,
  lines: Pick<ExtractedLine, "rawText" | "code">[],
): Promise<LineMatch[]> {
  const input = JSON.stringify(lines.map((l, n) => ({ n, raw: l.rawText, norm: normalizeLineText(l.rawText), code: l.code })));

  const rows = await db.transaction(async (tx) => {
    // Scoped to this transaction: lets the index-backed operators return weak suggestions too.
    await tx.execute(sql`SET LOCAL pg_trgm.similarity_threshold = ${sql.raw(String(SUGGEST_FROM))}`);
    await tx.execute(sql`SET LOCAL pg_trgm.word_similarity_threshold = ${sql.raw(String(SUGGEST_FROM))}`);
    const result = await tx.execute<{ n: number; alias_id: string | null; sku_id: string | null; candidates: Candidate[] }>(sql`
      WITH sup AS (
        SELECT id FROM suppliers
         WHERE user_id = ${userId} AND ${supplierName}::text IS NOT NULL
           AND (lower(name) = lower(${supplierName}) OR similarity(name, ${supplierName}) >= 0.6)
         ORDER BY lower(name) = lower(${supplierName}) DESC, similarity(name, ${supplierName}) DESC
         LIMIT 1
      ),
      l AS (SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS l(n int, raw text, norm text, code text))
      SELECT l.n,
             (SELECT a.product_id FROM supplier_aliases a JOIN products p ON p.id = a.product_id
               WHERE a.user_id = ${userId} AND p.user_id = ${userId} AND p.is_active
                 AND a.supplier_id = (SELECT id FROM sup) AND a.raw_text = l.norm) AS alias_id,
             (SELECT p.id FROM products p
               WHERE p.user_id = ${userId} AND p.is_active AND l.code IS NOT NULL
                 AND lower(p.sku) = lower(btrim(l.code))) AS sku_id,
             (SELECT COALESCE(json_agg(c ORDER BY c.score DESC), '[]'::json) FROM (
                SELECT p.id AS "productId", p.name, p.sku,
                       ROUND(GREATEST(similarity(p.name, l.raw), word_similarity(l.raw, p.name))::numeric, 2)::float8 AS score
                  FROM products p
                 WHERE p.user_id = ${userId} AND p.is_active AND (p.name % l.raw OR l.raw <% p.name)
                 ORDER BY score DESC, p.name
                 LIMIT 3) c) AS candidates
        FROM l ORDER BY l.n`);
    return result.rows;
  });

  return rows.map((r): LineMatch => {
    const [top, second] = r.candidates;
    if (r.alias_id) return { productId: r.alias_id, by: "alias", score: 1, candidates: r.candidates };
    if (r.sku_id) return { productId: r.sku_id, by: "sku", score: 1, candidates: r.candidates };
    if (top && top.score >= AUTO_MATCH && (!second || top.score - second.score >= AMBIGUITY_MARGIN)) {
      return { productId: top.productId, by: "name", score: top.score, candidates: r.candidates };
    }
    return { productId: null, by: null, score: top?.score ?? null, candidates: r.candidates };
  });
}

/** Stores an extracted document as a draft. The upload's only write: one receipts row. */
export async function createDraft(userId: string, doc: ExtractedDocument) {
  const matches = await matchLines(userId, doc.supplierName, doc.lines);
  const extraction: DraftDocument = { ...doc, lines: doc.lines.map((l, i) => ({ ...l, match: matches[i] })) };
  const [draft] = await db
    .insert(receipts)
    .values({
      userId,
      status: "draft",
      source: "upload",
      reference: doc.reference,
      receivedAt: new Date(),
      extraction,
    })
    .returning({ id: receipts.id });
  return draft;
}

/** File bytes to a draft: validate, extract, match, store. Stock is not touched at any step. */
export async function uploadToDraft(
  userId: string,
  bytes: Uint8Array,
  options: Parameters<typeof extractDocument>[1] & { onBusy?: (b: Busy) => void } = {},
) {
  const prepared = await prepareDocument(bytes);
  const doc = await extractDocument(prepared, options);
  return createDraft(userId, doc);
}

export async function getDraft(userId: string, draftId: string) {
  if (!isUuid(draftId)) return null;
  const [row] = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, draftId), eq(receipts.userId, userId), eq(receipts.status, "draft")));
  return row ? { ...row, extraction: row.extraction as DraftDocument } : null;
}

export async function listDrafts(userId: string) {
  const rows = await db
    .select({ id: receipts.id, createdAt: receipts.createdAt, extraction: receipts.extraction })
    .from(receipts)
    .where(and(eq(receipts.userId, userId), eq(receipts.status, "draft")))
    .orderBy(desc(receipts.createdAt));
  return rows.map((r) => {
    const doc = r.extraction as DraftDocument;
    return { id: r.id, createdAt: r.createdAt, supplierName: doc.supplierName, lines: doc.lines.length };
  });
}

/** A draft that should not be confirmed. Drafts are not ledger; deleting one changes no history. */
export async function discardDraft(userId: string, draftId: string) {
  if (!isUuid(draftId)) throw new ServiceError("not_found", "no such draft for this account");
  const gone = await db
    .delete(receipts)
    .where(and(eq(receipts.id, draftId), eq(receipts.userId, userId), eq(receipts.status, "draft")))
    .returning({ id: receipts.id });
  if (gone.length === 0) throw new ServiceError("not_found", "no such draft for this account");
}
