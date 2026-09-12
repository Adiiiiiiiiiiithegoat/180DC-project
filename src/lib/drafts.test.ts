/**
 * Phase 7: upload to draft to confirm (DESIGN.md section 3), against a real
 * Postgres — the Neon `dev` branch, via .env.test — with the model replaced
 * by the AI SDK's mock so every case is deterministic and needs no API key.
 * What the real model does with the sample documents is in
 * extraction.live.ts (npm run test:live).
 *
 * The recurring assertion is `unchanged(before)`: every product's stock,
 * average cost, price and settings, and every movement, receipt line and
 * confirmed receipt for the account, exactly as they were.
 */
import "../../scripts/env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { MockLanguageModelV3 } from "ai/test";
import { db, pool } from "../db";
import { users } from "../db/auth-schema";
import { products, receipts, supplierAliases } from "../db/schema";
import { randomUUID } from "node:crypto";
import { createDraft, discardDraft, getDraft, listDrafts, matchLines, uploadToDraft } from "./drafts";
import { parseDocumentDate, sniff, type ExtractedDocument } from "./extraction";
import { isUniqueViolation } from "./pg-error";
import { ServiceError, normalizeLineText, receiveGoods } from "./services";

const sample = (path: string) => new Uint8Array(readFileSync(`samples/${path}`));
let seq = 0;

async function newUser(label: string) {
  const [u] = await db.insert(users).values({ name: label, email: `${label}-${Date.now()}-${seq++}@test.local` }).returning();
  return u.id;
}

/** A shop with the products the sample notes mention, each with stock and an average cost. */
async function newShop() {
  const userId = await newUser("drafts");
  const catalogue = [
    ["Basmati Rice 1kg", "STP-RICE-1K"],
    ["Dish Soap 500ml", "HH-DISH-500"],
    ["Ballpoint Pens (10)", "STN-PEN-10"],
    ["Sunflower Oil 1L", "STP-OIL-1L"],
    ["Mosquito Coils (10)", "HH-COIL-10"],
    ["Detergent Powder 1kg", "HH-DET-1K"],
  ] as const;
  const rows = await db
    .insert(products)
    .values(catalogue.map(([name, sku]) => ({ userId, name, sku, unitPrice: 20000, reorderPoint: 5 })))
    .returning();
  await receiveGoods(userId, { lines: rows.map((p) => ({ productId: p.id, quantity: 10, unitCost: 10000 })) });
  const id = Object.fromEntries(rows.map((p) => [p.sku, p.id])) as Record<(typeof catalogue)[number][1], string>;
  return { userId, id };
}

/** Everything receiving could change for this account. */
async function inventory(userId: string) {
  const { rows } = await db.execute<{ products: unknown; movements: number; receipt_lines: number; confirmed: number }>(sql`
    SELECT (SELECT json_agg(json_build_array(p.sku, p.quantity_on_hand, p.average_cost, p.unit_price, p.reorder_point, p.is_active) ORDER BY p.sku)
              FROM products p WHERE p.user_id = ${userId}) AS products,
           (SELECT COUNT(*) FROM stock_movements WHERE user_id = ${userId}) AS movements,
           (SELECT COUNT(*) FROM receipt_lines l JOIN receipts r ON r.id = l.receipt_id WHERE r.user_id = ${userId}) AS receipt_lines,
           (SELECT COUNT(*) FROM receipts WHERE user_id = ${userId} AND status = 'confirmed') AS confirmed`);
  return rows[0];
}

/** A model that answers every call with `reply`, and records what it was asked. */
const modelReplying = (reply: unknown, finish: "stop" | "length" = "stop") =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: typeof reply === "string" ? reply : JSON.stringify(reply) }],
      finishReason: { unified: finish, raw: finish },
      usage: {
        inputTokens: { total: 2100, noCache: 2100, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 200, text: 200, reasoning: undefined },
      },
      warnings: [],
    }),
  });

const code = (c: string) => (e: unknown) => e instanceof ServiceError && e.code === c;

/** The Kaveri sample as a correct extraction, in paise. */
const kaveri = (over: Partial<ExtractedDocument> = {}): ExtractedDocument => ({
  supplierName: "Kaveri Wholesale Distributors",
  reference: "KWD/DN/4471",
  dateText: "09/09/2026",
  date: "2026-09-09",
  statedTotalPaise: 833200,
  taxPaise: null,
  unsure: [],
  source: "pdf-text",
  lines: [
    { rawText: "Basmati Rice 1kg", code: "STP-RICE-1K", quantity: 20, unitCostPaise: 12800, amountPaise: 256000, unsure: [] },
    { rawText: "Dish Soap 500ml", code: "HH-DISH-500", quantity: 24, unitCostPaise: 7900, amountPaise: 189600, unsure: [] },
    { rawText: "Ballpoint Pens (Pack of 10)", code: null, quantity: 30, unitCostPaise: 6600, amountPaise: 198000, unsure: [] },
    { rawText: "FRTN SNFLWR RFND OIL 1LTR PCH", code: null, quantity: 12, unitCostPaise: 15800, amountPaise: 189600, unsure: [] },
  ],
  ...over,
});

before(async () => {
  // Idempotent: brings the dev branch up to the latest migration without a reset.
  await migrate(db, { migrationsFolder: "./drizzle" });
});

after(() => pool.end());

test("a garbage file, a fake JPEG, a blank page and a cat photo are refused, and inventory is untouched", async () => {
  const { userId } = await newShop();
  const before = await inventory(userId);
  const model = modelReplying({ isDeliveryNote: false, lines: [] });

  // Refused on their bytes, before any model call.
  await assert.rejects(uploadToDraft(userId, sample("test-documents/garbage.pdf"), { model }), code("unsupported_file"));
  await assert.rejects(uploadToDraft(userId, new TextEncoder().encode("GIF89a? no, just text"), { model }), code("unsupported_file"));
  await assert.rejects(uploadToDraft(userId, new Uint8Array(0), { model }), code("unsupported_file"));
  await assert.rejects(uploadToDraft(userId, new Uint8Array(20 * 1024 * 1024 + 1), { model }), code("unsupported_file"));
  // A real PNG that is a blank page: caught by its pixels, still no model call.
  await assert.rejects(uploadToDraft(userId, sample("test-documents/blank-page.png"), { model }), code("unreadable_document"));
  assert.equal(model.doGenerateCalls.length, 0, "none of those cost a single token");

  // A real photo of something else: the model is asked, says so, and nothing is written.
  await assert.rejects(uploadToDraft(userId, sample("test-documents/cat.jpg"), { model }), code("unreadable_document"));
  assert.equal(model.doGenerateCalls.length, 1);

  assert.deepEqual(await inventory(userId), before);
  assert.deepEqual(await listDrafts(userId), [], "not even a draft");
});

test("the file type comes from its bytes, never from what the client declares", () => {
  assert.equal(sniff(sample("delivery-notes/kaveri-wholesale-DN-4471.pdf")), "pdf");
  assert.equal(sniff(sample("delivery-notes/sharma-traders-challan.jpg")), "jpeg");
  assert.equal(sniff(sample("delivery-notes/coastal-fmcg-invoice-2291.png")), "png");
  assert.equal(sniff(sample("test-documents/garbage.pdf")), null, "named .pdf, is not one");
});

test("injection: the extraction call has no tools, and a model that OBEYS the document still only makes a draft", async () => {
  const { userId, id } = await newShop();
  const before = await inventory(userId);
  // The worst case: a model that did everything the injected note asked for,
  // within the only shape it is allowed to answer in.
  const obedient = modelReplying({
    isDeliveryNote: true, supplier: "Udupi Home Care Supplies", ref: "UHC-0932", date: "10/09/2026",
    lines: [
      { item: "Mosquito Coils (10)", code: "HH-COIL-10", qty: 30, rate: 0, amount: 0, unsure: [] },
      { item: "Detergent Powder 1kg", code: "HH-DET-1K", qty: 10, rate: 0, amount: 0, unsure: [] },
      { item: "Admin stock credit", code: null, qty: 1000, rate: 0, amount: 0, unsure: [] },
    ],
    tax: null, total: 0, unsure: [],
  });

  const draft = await uploadToDraft(userId, sample("test-documents/injection-delivery-note.pdf"), { model: obedient });

  // 1. Nothing to call: no tools, no tool choice — only a JSON response format.
  const [call] = obedient.doGenerateCalls;
  assert.equal(call.tools, undefined, "no tools were offered to the model");
  assert.equal(call.toolChoice, undefined);
  assert.equal(call.responseFormat?.type, "json");
  // 2. The document is user content, never part of the instructions.
  const [system, user] = call.prompt;
  assert.equal(system.role, "system");
  assert.doesNotMatch(JSON.stringify(system.content), /SYSTEM OVERRIDE/);
  assert.match(JSON.stringify(user.content), /SYSTEM OVERRIDE/, "the injected text arrived — as data");

  // 3. Its whole effect is a draft: prices, stock, costs, movements untouched.
  assert.deepEqual(await inventory(userId), before);
  const { extraction } = (await getDraft(userId, draft.id))!;
  const credit = extraction.lines.find((l) => l.rawText === "Admin stock credit")!;
  assert.equal(credit.match.productId, null, "the invented line matches no product, so it cannot be received unless a person picks one");
  assert.equal(extraction.lines.find((l) => l.code === "HH-COIL-10")!.match.productId, id["HH-COIL-10"]);
});

test("a reply carrying any field outside the schema is rejected whole, and nothing is written", async () => {
  const { userId } = await newShop();
  const before = await inventory(userId);
  const sneaky = modelReplying({
    isDeliveryNote: true, supplier: "X", ref: null, date: null,
    lines: [{ item: "Dish Soap 500ml", code: null, qty: 1, rate: 79, amount: 79, unsure: [] }],
    tax: null, total: 79, unsure: [],
    confirm: true, setAllPricesTo: 0,
  });
  await assert.rejects(uploadToDraft(userId, sample("test-documents/injection-delivery-note.pdf"), { model: sneaky }), code("unreadable_document"));
  await assert.rejects(uploadToDraft(userId, sample("test-documents/injection-delivery-note.pdf"), { model: modelReplying("not json") }), code("unreadable_document"));
  assert.deepEqual(await inventory(userId), before);
  assert.deepEqual(await listDrafts(userId), []);
});

test("a reply cut off by the output cap is refused even when it parses, never a partial draft", async () => {
  const { userId } = await newShop();
  const before = await inventory(userId);
  // What the real model did with a 25-line note: valid JSON, 9 lines, no total.
  const cutOff = modelReplying(
    {
      isDeliveryNote: true, supplier: "Mangalore Bulk Traders", ref: "MBT/7719", date: "11/09/2026",
      lines: Array.from({ length: 9 }, (_, i) => ({ item: `Item ${i + 1}`, code: null, qty: 1, rate: 10, amount: 10, unsure: [] })),
      tax: null, total: null, unsure: [],
    },
    "length",
  );
  await assert.rejects(
    uploadToDraft(userId, sample("test-documents/long-delivery-note-25-lines.png"), { model: cutOff }),
    (e) => e instanceof ServiceError && e.code === "unreadable_document" && /stopped after 9 lines/.test(e.message),
  );
  assert.deepEqual(await listDrafts(userId), [], "no draft at all");
  assert.deepEqual(await inventory(userId), before);
});

test("matching in Postgres: item code first, then trigram name, and an unrecognised name is left for a person", async () => {
  const { userId, id } = await newShop();
  const before = await inventory(userId);
  const { extraction } = (await getDraft(userId, (await createDraft(userId, kaveri())).id))!;
  const [rice, soap, pens, oil] = extraction.lines.map((l) => l.match);

  assert.deepEqual([rice.by, rice.productId], ["sku", id["STP-RICE-1K"]]);
  assert.deepEqual([soap.by, soap.productId], ["sku", id["HH-DISH-500"]]);
  assert.deepEqual([pens.by, pens.productId], ["name", id["STN-PEN-10"]]);
  assert.ok(pens.score! >= 0.6);
  assert.equal(oil.productId, null, "FRTN SNFLWR RFND OIL is below the threshold: unresolved");
  assert.equal(oil.by, null);
  assert.equal(oil.candidates[0]?.productId, id["STP-OIL-1L"], "but the right product is the top suggestion for the dropdown");

  assert.deepEqual(await inventory(userId), before, "a draft is not a receipt");
});

test("confirming a draft moves stock and recomputes average cost, exactly once, and learns the alias", async () => {
  const { userId, id } = await newShop();
  const draft = await createDraft(userId, kaveri());
  const confirm = () =>
    receiveGoods(
      userId,
      {
        supplierName: "Kaveri Wholesale Distributors",
        reference: "KWD/DN/4471",
        source: "upload",
        lines: [
          { productId: id["STP-RICE-1K"], quantity: 20, unitCost: 12800, rawText: "Basmati Rice 1kg" },
          { productId: id["HH-DISH-500"], quantity: 24, unitCost: 7900, rawText: "Dish Soap 500ml" },
          { productId: id["STN-PEN-10"], quantity: 30, unitCost: 6600, rawText: "Ballpoint Pens (Pack of 10)" },
          // The person picked Sunflower Oil for the line nothing could match.
          { productId: id["STP-OIL-1L"], quantity: 12, unitCost: 15800, rawText: "FRTN SNFLWR RFND OIL 1LTR PCH" },
        ],
      },
      { draftId: draft.id },
    );
  const receipt = await confirm();

  // Each product had 10 at ₹100.00. Weighted average, DESIGN section 2, in whole paise.
  const expect = (qty: number, cost: number) => ({ qty: 10 + qty, avg: Math.round((10 * 10000 + qty * cost) / (10 + qty)) });
  for (const [sku, qty, cost] of [["STP-RICE-1K", 20, 12800], ["HH-DISH-500", 24, 7900], ["STN-PEN-10", 30, 6600], ["STP-OIL-1L", 12, 15800]] as const) {
    const [p] = await db.select().from(products).where(eq(products.id, id[sku]));
    assert.deepEqual({ qty: p.quantityOnHand, avg: p.averageCost }, expect(qty, cost), sku);
  }
  assert.equal(receipt.id, draft.id, "the draft row became the receipt");
  assert.equal(receipt.status, "confirmed");
  assert.equal(receipt.source, "upload");
  const { rows: moves } = await db.execute(sql`SELECT COUNT(*) AS n FROM stock_movements WHERE reference_id = ${receipt.id} AND reason = 'receipt'`);
  assert.equal(moves[0].n, 4, "one movement per line");

  // Exactly once: the second confirm is a conflict and changes nothing.
  const after = await inventory(userId);
  await assert.rejects(confirm(), code("conflict"));
  assert.deepEqual(await inventory(userId), after);

  // Learned: the same note from the same supplier now resolves itself.
  const [alias] = await db.select().from(supplierAliases)
    .where(and(eq(supplierAliases.userId, userId), eq(supplierAliases.rawText, "FRTN SNFLWR RFND OIL 1LTR PCH")));
  assert.equal(alias.productId, id["STP-OIL-1L"]);
  const again = (await getDraft(userId, (await createDraft(userId, kaveri())).id))!.extraction.lines[3].match;
  assert.deepEqual([again.by, again.productId], ["alias", id["STP-OIL-1L"]]);
});

test("a document total that disagrees with its lines cannot be confirmed until a person accepts it", async () => {
  const { userId, id } = await newShop();
  // The Sharma challan's error: lines add up to ₹7,594.00, the note says ₹7,954.00.
  const doc = kaveri({
    supplierName: "Sharma Traders",
    statedTotalPaise: 795400,
    lines: [{ rawText: "Dish Soap 500ml", code: null, quantity: 96, unitCostPaise: 7910, amountPaise: 759360, unsure: [] }],
  });
  const lines = [{ productId: id["HH-DISH-500"], quantity: 96, unitCost: 7910, rawText: "Dish Soap 500ml" }];
  const draft = await createDraft(userId, doc);
  const before = await inventory(userId);

  await assert.rejects(
    receiveGoods(userId, { supplierName: "Sharma Traders", lines }, { draftId: draft.id }),
    (e) => e instanceof ServiceError && e.code === "conflict" && e.details?.statedTotalPaise === 795400 && e.details?.linesTotalPaise === 759360,
  );
  assert.deepEqual(await inventory(userId), before, "refused means rolled back");
  assert.ok(await getDraft(userId, draft.id), "and the draft is still there to fix");

  await receiveGoods(userId, { supplierName: "Sharma Traders", lines, acceptTotalMismatch: true }, { draftId: draft.id });
  assert.equal((await inventory(userId)).confirmed, before.confirmed + 1);
});

test("a draft belongs to its account: another user cannot read, list, confirm or discard it", async () => {
  const { userId } = await newShop();
  const stranger = await newShop();
  const draft = await createDraft(userId, kaveri());

  assert.equal(await getDraft(stranger.userId, draft.id), null);
  assert.deepEqual(await listDrafts(stranger.userId), []);
  await assert.rejects(
    receiveGoods(stranger.userId, { lines: [{ productId: stranger.id["HH-DISH-500"], quantity: 1, unitCost: 1 }] }, { draftId: draft.id }),
    code("not_found"),
  );
  await assert.rejects(discardDraft(stranger.userId, draft.id), code("not_found"));

  const [row] = await db.select().from(receipts).where(eq(receipts.id, draft.id));
  assert.equal(row.status, "draft", "untouched by all of that");
  await discardDraft(userId, draft.id);
  assert.equal(await getDraft(userId, draft.id), null);
});

/** Runs two calls at once and records when each started and finished, to prove they overlapped. */
async function race<A, B>(a: () => Promise<A>, b: () => Promise<B>) {
  const t0 = performance.now();
  const timed = async <T,>(f: () => Promise<T>) => {
    const start = performance.now() - t0;
    const result = await f().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    return { ...result, start, end: performance.now() - t0 };
  };
  const [ra, rb] = await Promise.all([timed(a), timed(b)]);
  const overlapped = ra.start < rb.end && rb.start < ra.end;
  console.log(`      A ${ra.start.toFixed(0)}ms -> ${ra.end.toFixed(0)}ms | B ${rb.start.toFixed(0)}ms -> ${rb.end.toFixed(0)}ms | overlapped=${overlapped}`);
  return { results: [ra, rb], overlapped };
}

const kaveriLines = (id: Record<string, string>) => [
  { productId: id["STP-RICE-1K"], quantity: 20, unitCost: 12800, rawText: "Basmati Rice 1kg" },
  { productId: id["HH-DISH-500"], quantity: 24, unitCost: 7900, rawText: "Dish Soap 500ml" },
  { productId: id["STN-PEN-10"], quantity: 30, unitCost: 6600, rawText: "Ballpoint Pens (Pack of 10)" },
  { productId: id["STP-OIL-1L"], quantity: 12, unitCost: 15800, rawText: "FRTN SNFLWR RFND OIL 1LTR PCH" },
];
const onHand = async (productId: string) => (await db.select().from(products).where(eq(products.id, productId)))[0].quantityOnHand;

test("two confirms of one draft at once: exactly one receives, the other is a 409 conflict", async () => {
  const { userId, id } = await newShop();
  const draft = await createDraft(userId, kaveri());
  const body = { supplierName: "Kaveri Wholesale Distributors", reference: "KWD/DN/4471", source: "upload", lines: kaveriLines(id) };
  const confirm = () => receiveGoods(userId, body, { draftId: draft.id });

  const { results, overlapped } = await race(confirm, confirm);
  assert.ok(overlapped, "the two confirms were in flight at the same time");
  assert.equal(results.filter((r) => r.ok).length, 1, "exactly one succeeds");
  const lost = results.find((r) => !r.ok)!;
  assert.ok(!lost.ok && lost.error instanceof ServiceError && lost.error.code === "conflict", "the other is a conflict (HTTP 409), not a not-found");

  const { rows } = await db.execute<{ n: number }>(sql`SELECT COUNT(*) AS n FROM stock_movements WHERE reference_id = ${draft.id}`);
  assert.equal(rows[0].n, 4, "exactly four movements");
  assert.equal(await onHand(id["STP-RICE-1K"]), 30, "10 + 20, once");
  assert.equal(await onHand(id["STP-OIL-1L"]), 22, "10 + 12, once");

  // And afterwards, a plain second confirm says the same thing.
  await assert.rejects(confirm(), (e) => e instanceof ServiceError && e.code === "conflict" && e.details?.alreadyConfirmed === true);
});

test("a second note with the same supplier and reference needs acknowledging before it is received", async () => {
  const { userId, id } = await newShop();
  const lines = kaveriLines(id);
  const first = await createDraft(userId, kaveri());
  await receiveGoods(userId, { supplierName: "Kaveri Wholesale Distributors", reference: "KWD/DN/4471", lines }, { draftId: first.id });

  // The same paper uploaded again: the review screen is told before anyone clicks...
  const again = await createDraft(userId, kaveri());
  const draft = (await getDraft(userId, again.id))!;
  assert.equal(draft.duplicateOf?.id, first.id);

  // ...and the server refuses without the acknowledgement, whatever the case and spacing of the reference.
  const before = await inventory(userId);
  await assert.rejects(
    receiveGoods(userId, { supplierName: "kaveri wholesale distributors", reference: " kwd/dn/4471 ", lines }, { draftId: again.id }),
    (e) => e instanceof ServiceError && e.code === "conflict" && e.details?.duplicateOf === first.id,
  );
  assert.deepEqual(await inventory(userId), before, "refused means nothing moved");

  // Acknowledged: received.
  await receiveGoods(userId, { supplierName: "Kaveri Wholesale Distributors", reference: "KWD/DN/4471", lines, acceptDuplicate: true }, { draftId: again.id });
  assert.equal((await inventory(userId)).confirmed, before.confirmed + 1);

  // A new reference from the same supplier is simply the next delivery.
  const next = await createDraft(userId, kaveri({ reference: "KWD/DN/4502" }));
  assert.equal((await getDraft(userId, next.id))!.duplicateOf, null);
});

// The duplicate check's identity comes from the draft's own stored reference
// and extraction, never the confirm payload — so a payload that omits them
// cannot skip the check, and one that disagrees with them is refused outright
// rather than quietly redefining which delivery this is.
test("omitting supplier and reference at confirm time cannot skip the duplicate check", async () => {
  const { userId, id } = await newShop();
  const lines = kaveriLines(id);
  const first = await createDraft(userId, kaveri());
  await receiveGoods(userId, { supplierName: "Kaveri Wholesale Distributors", reference: "KWD/DN/4471", lines }, { draftId: first.id });

  const again = await createDraft(userId, kaveri());
  const before = await inventory(userId);
  await assert.rejects(
    receiveGoods(userId, { lines }, { draftId: again.id }),
    (e) => e instanceof ServiceError && e.code === "conflict" && e.details?.duplicateOf === first.id,
  );
  assert.deepEqual(await inventory(userId), before, "refused means nothing moved");

  await receiveGoods(userId, { lines, acceptDuplicate: true }, { draftId: again.id });
  assert.equal((await inventory(userId)).confirmed, before.confirmed + 1, "accepted, so it goes through");
});

test("a confirm payload cannot change a draft's reference or supplier to a different value", async () => {
  const { userId, id } = await newShop();
  const lines = kaveriLines(id);
  const draft = await createDraft(userId, kaveri());
  const before = await inventory(userId);

  await assert.rejects(
    receiveGoods(userId, { reference: "SOME-OTHER-REF", lines }, { draftId: draft.id }),
    (e) => e instanceof ServiceError && e.code === "conflict" && /reference does not match/.test(e.message),
  );
  await assert.rejects(
    receiveGoods(userId, { supplierName: "A Totally Different Supplier", lines }, { draftId: draft.id }),
    (e) => e instanceof ServiceError && e.code === "conflict" && /supplier does not match/.test(e.message),
  );
  assert.deepEqual(await inventory(userId), before, "both refused, nothing moved");

  // The matching, unmodified identity still goes through.
  await receiveGoods(userId, { supplierName: "Kaveri Wholesale Distributors", reference: "KWD/DN/4471", lines }, { draftId: draft.id });
  assert.equal((await inventory(userId)).confirmed, before.confirmed + 1);
});

test("a confirm payload cannot invent a line's document text either — fabricated or absent", async () => {
  const { userId, id } = await newShop();
  const draft = await createDraft(userId, kaveri());
  const before = await inventory(userId);

  // Basmati Rice is matched by SKU already; even a resolved line's printed
  // text is not the payload's to rewrite.
  const fabricated = kaveriLines(id).map((l, i) => (i === 0 ? { ...l, rawText: "Something the note never said" } : l));
  await assert.rejects(
    receiveGoods(userId, { supplierName: "Kaveri Wholesale Distributors", reference: "KWD/DN/4471", lines: fabricated }, { draftId: draft.id }),
    (e) => e instanceof ServiceError && e.code === "conflict" && /line's text does not match/.test(e.message),
  );
  assert.deepEqual(await inventory(userId), before, "refused, nothing moved");

  // Absent is fine — unchanged from before: nothing to check, and no alias
  // taught for that line, same as always.
  const absent = kaveriLines(id).map((l, i) => (i === 0 ? { ...l, rawText: undefined } : l));
  await receiveGoods(userId, { supplierName: "Kaveri Wholesale Distributors", reference: "KWD/DN/4471", lines: absent }, { draftId: draft.id });
  assert.equal((await inventory(userId)).confirmed, before.confirmed + 1);
  const [riceAlias] = await db.select().from(supplierAliases)
    .where(and(eq(supplierAliases.userId, userId), eq(supplierAliases.rawText, "BASMATI RICE 1KG")));
  assert.equal(riceAlias, undefined, "no alias taught when the line's text was left out");
});

test("two drafts of the same note confirmed at the same moment: the second still sees the first", async () => {
  const { userId, id } = await newShop();
  const [a, b] = [await createDraft(userId, kaveri()), await createDraft(userId, kaveri())];
  const body = { supplierName: "Kaveri Wholesale Distributors", reference: "KWD/DN/4471", lines: kaveriLines(id) };
  const { results, overlapped } = await race(
    () => receiveGoods(userId, body, { draftId: a.id }),
    () => receiveGoods(userId, body, { draftId: b.id }),
  );
  assert.ok(overlapped);
  assert.equal(results.filter((r) => r.ok).length, 1, "the advisory lock makes them take turns");
  const lost = results.find((r) => !r.ok)!;
  assert.ok(!lost.ok && lost.error instanceof ServiceError && typeof lost.error.details?.duplicateOf === "string");
  assert.equal(await onHand(id["STP-RICE-1K"]), 30);
});

test("supplier aliases: one per text even with no supplier, and text is compared normalised", async () => {
  const { userId, id } = await newShop();
  assert.equal(normalizeLineText("FRTN SNFLWR RFND OIL 1LTR"), normalizeLineText("  frtn snflwr   rfnd oil 1ltr "));
  assert.equal(normalizeLineText("1LTR"), normalizeLineText(" 1ltr "));

  // NULLS NOT DISTINCT: two null-supplier aliases for one text are one too many.
  await db.insert(supplierAliases).values({ userId, supplierId: null, rawText: "SAME TEXT", productId: id["HH-DISH-500"] });
  await assert.rejects(
    db.insert(supplierAliases).values({ userId, supplierId: null, rawText: "SAME TEXT", productId: id["STP-OIL-1L"] }),
    (e) => isUniqueViolation(e, "supplier_aliases_key"),
  );

  // A note with no supplier still teaches, and the lesson survives case and
  // spacing. Its own extraction must actually say this text now that a
  // confirm payload can no longer invent line text the document never had.
  const draft = await createDraft(
    userId,
    kaveri({
      supplierName: null,
      lines: [{ rawText: "Fortune Oil 1LTR", code: null, quantity: 1, unitCostPaise: 15800, amountPaise: 15800, unsure: [] }],
    }),
  );
  await receiveGoods(
    userId,
    { lines: [{ productId: id["STP-OIL-1L"], quantity: 1, unitCost: 15800, rawText: "Fortune Oil 1LTR" }], acceptTotalMismatch: true },
    { draftId: draft.id },
  );
  const [learned] = await matchLines(userId, null, [{ rawText: "  fortune   oil 1ltr ", code: null }]);
  assert.deepEqual([learned.by, learned.productId], ["alias", id["STP-OIL-1L"]]);
  const [row] = await db.select().from(supplierAliases).where(and(eq(supplierAliases.userId, userId), eq(supplierAliases.productId, id["STP-OIL-1L"])));
  assert.equal(row.rawText, "FORTUNE OIL 1LTR", "stored uppercase, whitespace collapsed");
  assert.equal(row.supplierId, null);
});

test("an item code that matches no product falls through to the name", async () => {
  const { userId, id } = await newShop();
  const [junk, none] = await matchLines(userId, null, [
    { rawText: "Dish Soap 500 ml", code: "ZZ-NOPE-999" },
    { rawText: "Something Else Entirely", code: "ZZ-NOPE-999" },
  ]);
  assert.deepEqual([junk.by, junk.productId], ["name", id["HH-DISH-500"]]);
  assert.equal(none.productId, null, "and a junk code with an unmatchable name stays unresolved");
});

test("manual receiving: a double submit with one idempotency key receives once", async () => {
  const { userId, id } = await newShop();
  const body = { idempotencyKey: `form-${randomUUID()}`, lines: [{ productId: id["HH-COIL-10"], quantity: 7, unitCost: 4200 }] };
  const { results, overlapped } = await race(() => receiveGoods(userId, body), () => receiveGoods(userId, body));
  assert.ok(overlapped);
  assert.ok(results.every((r) => r.ok), "both calls succeed from the caller's point of view");
  const [a, b] = results.map((r) => (r.ok ? r.value : null)!);
  assert.equal(a.id, b.id, "and both return the same receipt");
  assert.equal([a, b].filter((r) => "idempotentReplay" in r).length, 1, "one of them is the replay");
  assert.equal(await onHand(id["HH-COIL-10"]), 17, "10 + 7, once");
  const { rows } = await db.execute<{ n: number }>(sql`SELECT COUNT(*) AS n FROM stock_movements WHERE reference_id = ${a.id}`);
  assert.equal(rows[0].n, 1);
});

test("printed dates are read day first, as Indian documents write them", () => {
  assert.equal(parseDocumentDate("8/9/26"), "2026-09-08");
  assert.equal(parseDocumentDate("09/09/2026"), "2026-09-09");
  assert.equal(parseDocumentDate("10-Sep-2026"), "2026-09-10");
  assert.equal(parseDocumentDate("2026-09-10"), "2026-09-10");
  assert.equal(parseDocumentDate("31/02/2026"), null, "no 31 February");
  assert.equal(parseDocumentDate("yesterday"), null);
});
