/**
 * The real model on the real sample documents: npm run test:live
 *
 * Not part of `npm test`: it calls Groq (needs GROQ_API_KEY, from .env.local),
 * spends free-tier tokens, and waits out rate limits. Pure extraction: nothing
 * here touches a database. The deterministic half — what reaches the model,
 * what can come back, and that none of it moves stock — is drafts.test.ts.
 */
import "../../scripts/env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractDocument, prepareDocument } from "./extraction";
import { ServiceError } from "./services";

const read = async (path: string) =>
  extractDocument(await prepareDocument(new Uint8Array(readFileSync(`samples/${path}`))), {
    onBusy: (b) => b.state === "waiting" && console.log(`    [rate limited: waiting ${b.seconds}s]`),
  });
const rows = (doc: Awaited<ReturnType<typeof read>>) => doc.lines.map((l) => [l.quantity, l.unitCostPaise]);
const sum = (doc: Awaited<ReturnType<typeof read>>) => doc.lines.reduce((s, l) => s + l.quantity! * l.unitCostPaise!, 0);

test("injection document, as a photo: two real lines at their real costs, nothing else", async () => {
  const doc = await read("test-documents/injection-delivery-note.png");
  assert.deepEqual(rows(doc), [[30, 4200], [10, 10400]]);
  assert.deepEqual(doc.lines.map((l) => l.code), ["HH-COIL-10", "HH-DET-1K"]);
  assert.equal(doc.statedTotalPaise, 230000);
});

test("injection document, as a PDF (the instruction arrives as plain text): extracted just the same", async () => {
  const doc = await read("test-documents/injection-delivery-note.pdf");
  assert.deepEqual(rows(doc), [[30, 4200], [10, 10400]]);
  assert.equal(doc.statedTotalPaise, 230000);
});

test("Kaveri, clean PDF: four lines, item codes where printed, total agrees", async () => {
  const doc = await read("delivery-notes/kaveri-wholesale-DN-4471.pdf");
  assert.deepEqual(rows(doc), [[20, 12800], [24, 7900], [30, 6600], [12, 15800]]);
  assert.deepEqual(doc.lines.map((l) => l.code), ["STP-RICE-1K", "HH-DISH-500", null, null]);
  assert.equal(doc.lines[3].rawText, "FRTN SNFLWR RFND OIL 1LTR PCH");
  assert.equal(doc.statedTotalPaise, 833200);
  assert.equal(sum(doc), 833200);
});

test("Sharma, messy photo: the corrected quantity, and the note's wrong total kept as printed", async () => {
  const doc = await read("delivery-notes/sharma-traders-challan.jpg");
  assert.deepEqual(rows(doc), [[24, 12500], [15, 14200], [20, 5000], [48, 3050]]);
  assert.equal(doc.date, "2026-09-08");
  assert.equal(doc.statedTotalPaise, 795400, "transcribed, not recalculated");
  assert.equal(sum(doc), 759400, "so the review screen shows a ₹360 discrepancy");
});

test("Coastal, GST invoice: rates before tax, tax separate, lines + tax = grand total", async () => {
  const doc = await read("delivery-notes/coastal-fmcg-invoice-2291.png");
  assert.deepEqual(rows(doc), [[12, 17500], [10, 14000], [24, 7000]]);
  assert.equal(doc.taxPaise, 25900);
  assert.equal(doc.statedTotalPaise, 543900);
  assert.equal(sum(doc) + doc.taxPaise!, 543900);
});

test("a 25-line note is refused as too long, photo and PDF — never a partial draft", async () => {
  for (const file of ["long-delivery-note-25-lines.png", "long-delivery-note-25-lines.pdf"]) {
    await assert.rejects(
      read(`test-documents/${file}`),
      (e) => e instanceof ServiceError && e.code === "unreadable_document" && /Upload it in two parts/.test(e.message),
      file,
    );
  }
});

test("the second Kaveri note reads its oil line exactly as the first, so the learned alias applies", async () => {
  const first = await read("delivery-notes/kaveri-wholesale-DN-4471.pdf");
  const second = await read("delivery-notes/kaveri-wholesale-DN-4502.pdf");
  assert.equal(second.reference, "KWD/DN/4502");
  assert.deepEqual(rows(second), [[10, 14100], [36, 2000], [12, 7900], [18, 15800]]);
  assert.equal(second.lines[3].rawText, first.lines[3].rawText);
});

test("a photo of a cat is not a delivery note", async () => {
  await assert.rejects(read("test-documents/cat.jpg"), (e) => e instanceof ServiceError && e.code === "unreadable_document");
});
