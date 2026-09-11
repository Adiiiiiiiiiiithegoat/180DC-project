/**
 * What a 25-line delivery note does under the 700-token output cap:
 *   npx tsx --conditions=react-server scripts/long-note-probe.ts
 * Prints the app's outcome (extractDocument) for the photo and the PDF.
 */
import "./env";
import { readFileSync } from "node:fs";
import { extractDocument, prepareDocument } from "../src/lib/extraction";

async function main() {
for (const file of ["long-delivery-note-25-lines.png", "long-delivery-note-25-lines.pdf"]) {
  const bytes = new Uint8Array(readFileSync(`samples/test-documents/${file}`));
  const t0 = Date.now();
  try {
    const doc = await extractDocument(await prepareDocument(bytes), {
      onBusy: (b) => b.state === "waiting" && console.log(`  [rate limited: waiting ${b.seconds}s]`),
      onDiagnostics: (d) => console.log(`  model: finish=${d.finishReason} outputTokens=${d.outputTokens} replyChars=${d.replyChars}`),
    });
    const sum = doc.lines.reduce((s, l) => s + (l.quantity ?? 0) * (l.unitCostPaise ?? 0), 0);
    console.log(`${file}: DRAFT with ${doc.lines.length} lines, lines sum ₹${sum / 100}, stated total ₹${(doc.statedTotalPaise ?? 0) / 100}`);
  } catch (e) {
    console.log(`${file}: REFUSED in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${(e as Error & { code?: string }).code}: ${(e as Error).message}`);
  }
}
}

main();
