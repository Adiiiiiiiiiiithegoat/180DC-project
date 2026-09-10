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
import { createDraft, discardDraft, getDraft, listDrafts, uploadToDraft } from "./drafts";
import { parseDocumentDate, sniff, type ExtractedDocument } from "./extraction";
import { ServiceError, receiveGoods } from "./services";

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
const modelReplying = (reply: unknown) =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: typeof reply === "string" ? reply : JSON.stringify(reply) }],
      finishReason: { unified: "stop", raw: "stop" },
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

  // Exactly once: the second confirm finds no draft and changes nothing.
  const after = await inventory(userId);
  await assert.rejects(confirm(), code("not_found"));
  assert.deepEqual(await inventory(userId), after);

  // Learned: the same note from the same supplier now resolves itself.
  const [alias] = await db.select().from(supplierAliases)
    .where(and(eq(supplierAliases.userId, userId), eq(supplierAliases.rawText, "frtn snflwr rfnd oil 1ltr pch")));
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

test("printed dates are read day first, as Indian documents write them", () => {
  assert.equal(parseDocumentDate("8/9/26"), "2026-09-08");
  assert.equal(parseDocumentDate("09/09/2026"), "2026-09-09");
  assert.equal(parseDocumentDate("10-Sep-2026"), "2026-09-10");
  assert.equal(parseDocumentDate("2026-09-10"), "2026-09-10");
  assert.equal(parseDocumentDate("31/02/2026"), null, "no 31 February");
  assert.equal(parseDocumentDate("yesterday"), null);
});
