"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
// Types only: erased at build, so nothing server-side is bundled for the browser.
import type { DraftDocument, DraftLine } from "@/lib/drafts";
import { formatPaise, paiseToInput, parseRupees } from "@/lib/money";
import { button, buttonQuiet, input, label, td, th } from "./ui";

type Product = { id: string; name: string; sku: string; quantityOnHand: number; averageCost: number };

type Row = {
  key: string;
  line: DraftLine;
  include: boolean;
  productId: string;
  quantity: string;
  unitCost: string;
};

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

/**
 * Why a field needs a look, or null if it reads clean. Three signals, none of
 * them the model grading itself with a number: the model saying it could not
 * read the field, the printed arithmetic not adding up, and — for the product
 * — how well pg_trgm matched the name.
 */
function concern(line: DraftLine, field: "qty" | "rate"): string | null {
  if (line.unsure.includes(field)) return "the reader was unsure of this";
  const value = field === "qty" ? line.quantity : line.unitCostPaise;
  if (value === null) return "could not be read";
  if (field === "qty" && !Number.isInteger(value)) return "not a whole number";
  const { quantity: q, unitCostPaise: r, amountPaise: a } = line;
  if (q !== null && r !== null && a !== null && Math.abs(q * r - a) > 1) {
    return `qty × rate is ${formatPaise(Math.round(q * r))} but the note says ${formatPaise(a)}`;
  }
  return null;
}

function matchLabel(line: DraftLine): { text: string; tone: string } {
  const m = line.match;
  if (m.by === "alias") return { text: "matched: learned from this supplier", tone: "text-emerald-700" };
  if (m.by === "sku") return { text: "matched: item code", tone: "text-emerald-700" };
  if (m.by === "name") return { text: `matched by name, ${Math.round(m.score! * 100)}%`, tone: "text-emerald-700" };
  return {
    text: m.score === null ? "no match: pick the product" : `no confident match (best ${Math.round(m.score * 100)}%): pick the product`,
    tone: "text-red-700 font-medium",
  };
}

export function DraftReview({ draftId, doc, products }: { draftId: string; doc: DraftDocument; products: Product[] }) {
  const router = useRouter();
  const byId = new Map(products.map((p) => [p.id, p]));
  const [supplierName, setSupplierName] = useState(doc.supplierName ?? "");
  const [reference, setReference] = useState(doc.reference ?? "");
  const [receivedAt, setReceivedAt] = useState(today());
  const [rows, setRows] = useState<Row[]>(() =>
    doc.lines.map((line, i) => ({
      key: String(i),
      line,
      include: true,
      productId: line.match.productId ?? "",
      quantity: line.quantity === null ? "" : String(line.quantity),
      unitCost: line.unitCostPaise === null ? "" : paiseToInput(line.unitCostPaise),
    })),
  );
  const [acceptMismatch, setAcceptMismatch] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const parsed = rows.map((r) => ({
    row: r,
    quantity: /^\d+$/.test(r.quantity.trim()) ? Number(r.quantity) : null,
    unitCost: parseRupees(r.unitCost),
  }));
  const included = parsed.filter((p) => p.row.include);
  const linesTotal =
    included.reduce((s, p) => s + (p.quantity ?? 0) * (p.unitCost ?? 0), 0) + (doc.taxPaise ?? 0);
  const stated = doc.statedTotalPaise;
  const mismatch = stated !== null && stated !== linesTotal;
  const problems = included.filter((p) => !p.row.productId || !p.quantity || p.unitCost === null);
  const canConfirm = included.length > 0 && problems.length === 0 && (!mismatch || acceptMismatch) && !busy;

  async function confirm() {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/receipts/drafts/${draftId}/confirm`, "POST", {
        supplierName: supplierName.trim() || undefined,
        reference: reference.trim() || undefined,
        receivedAt,
        acceptTotalMismatch: acceptMismatch,
        lines: included.map((p) => ({
          productId: p.row.productId,
          quantity: p.quantity,
          unitCost: p.unitCost,
          rawText: p.row.line.rawText,
        })),
      });
      const units = included.reduce((s, p) => s + (p.quantity ?? 0), 0);
      setMessage({ ok: true, text: `Received ${units} units on ${included.length} line(s). Stock and average costs are updated.` });
      setTimeout(() => router.push("/receive"), 1500);
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
      setBusy(false);
    }
  }

  async function discard() {
    setBusy(true);
    try {
      await api(`/api/receipts/drafts/${draftId}`, "DELETE");
      router.push("/receive");
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-3">
        <label className={label}>
          Supplier
          <input className={input} value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
        </label>
        <label className={label}>
          Delivery note ref
          <input className={input} value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className={label}>
          Date received
          <input type="date" className={input} value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </label>
        <div className="self-end text-xs text-stone-500">
          Note dated {doc.dateText ?? "—"}
          {doc.date && doc.dateText !== doc.date && ` (read as ${doc.date})`} · read from {doc.source === "image" ? "a photo" : "a PDF"}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead className="border-b border-stone-200">
            <tr>
              <th className={th}>On the note</th>
              <th className={th}>Product</th>
              <th className={th}>Qty counted</th>
              <th className={th}>Unit cost (₹)</th>
              <th className={`${th} text-right`}>Line total</th>
              <th className={th}>Receive</th>
            </tr>
          </thead>
          <tbody>
            {parsed.map(({ row, quantity, unitCost }) => {
              const unresolved = row.include && !row.productId;
              const qtyConcern = concern(row.line, "qty");
              const rateConcern = concern(row.line, "rate");
              const m = matchLabel(row.line);
              const product = byId.get(row.productId);
              const suggested = row.line.match.candidates.filter((c) => byId.has(c.productId));
              return (
                <tr
                  key={row.key}
                  className={`border-b border-stone-100 align-top ${!row.include ? "opacity-40" : unresolved ? "bg-red-50" : ""}`}
                  data-unresolved={unresolved || undefined}
                >
                  <td className={td}>
                    <div className="font-medium">{row.line.rawText}</div>
                    <div className="text-xs text-stone-500">
                      {row.line.code && <>code {row.line.code} · </>}
                      printed {row.line.amountPaise === null ? "—" : formatPaise(row.line.amountPaise)}
                    </div>
                  </td>
                  <td className={td}>
                    <select
                      aria-label={`Product for ${row.line.rawText}`}
                      value={row.productId}
                      onChange={(e) => update(row.key, { productId: e.target.value })}
                      className={`${input} w-60 ${unresolved ? "border-red-400" : ""}`}
                    >
                      <option value="">Choose…</option>
                      {suggested.length > 0 && (
                        <optgroup label="Suggested">
                          {suggested.map((c) => (
                            <option key={`s-${c.productId}`} value={c.productId}>
                              {c.name} ({Math.round(c.score * 100)}%)
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="All products">
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.sku})
                          </option>
                        ))}
                      </optgroup>
                    </select>
                    <div className={`mt-1 text-xs ${row.productId && row.productId !== row.line.match.productId ? "text-stone-600" : m.tone}`}>
                      {row.productId && row.productId !== row.line.match.productId ? "chosen by you — will be remembered for this supplier" : m.text}
                    </div>
                    {product && (
                      <div className="text-xs text-stone-500">
                        on hand {product.quantityOnHand} @ avg {formatPaise(product.averageCost)}
                      </div>
                    )}
                  </td>
                  <td className={td}>
                    <input
                      aria-label={`Quantity for ${row.line.rawText}`}
                      inputMode="numeric"
                      value={row.quantity}
                      onChange={(e) => update(row.key, { quantity: e.target.value })}
                      className={`${input} w-20 ${qtyConcern || (row.include && !quantity) ? "border-amber-500 bg-amber-50" : ""}`}
                    />
                    <div className={`mt-1 text-xs ${qtyConcern ? "text-amber-800" : "text-stone-400"}`}>{qtyConcern ?? "read clearly"}</div>
                  </td>
                  <td className={td}>
                    <input
                      aria-label={`Unit cost for ${row.line.rawText}`}
                      inputMode="decimal"
                      value={row.unitCost}
                      onChange={(e) => update(row.key, { unitCost: e.target.value })}
                      className={`${input} w-24 ${rateConcern || (row.include && unitCost === null) ? "border-amber-500 bg-amber-50" : ""}`}
                    />
                    <div className={`mt-1 text-xs ${rateConcern ? "text-amber-800" : "text-stone-400"}`}>{rateConcern ?? "read clearly"}</div>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {quantity && unitCost !== null ? formatPaise(quantity * unitCost) : "—"}
                  </td>
                  <td className={td}>
                    <input
                      type="checkbox"
                      aria-label={`Receive ${row.line.rawText}`}
                      checked={row.include}
                      onChange={(e) => update(row.key, { include: e.target.checked })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        className={`rounded border px-4 py-3 text-sm ${mismatch ? "border-red-300 bg-red-50" : "border-emerald-200 bg-emerald-50"}`}
        data-testid="total-check"
      >
        <div className="flex flex-wrap gap-x-8 gap-y-1 tabular-nums">
          <span>
            Lines{doc.taxPaise ? ` + tax ${formatPaise(doc.taxPaise)}` : ""}: <b>{formatPaise(linesTotal)}</b>
          </span>
          <span>
            Document total: <b>{stated === null ? "not printed" : formatPaise(stated)}</b>
          </span>
        </div>
        {mismatch ? (
          <>
            <p className="mt-2 font-medium text-red-800">
              These disagree by {formatPaise(Math.abs(stated! - linesTotal))}. Either a line was read wrong, or the note
              itself is wrong. Check the lines against the paper.
            </p>
            <label className="mt-2 flex items-center gap-2 text-red-900">
              <input type="checkbox" checked={acceptMismatch} onChange={(e) => setAcceptMismatch(e.target.checked)} />
              I have checked: the lines are right and the note&apos;s total is wrong.
            </label>
          </>
        ) : (
          stated !== null && <p className="mt-1 text-emerald-800">The lines add up to the document&apos;s total.</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={button} disabled={!canConfirm} onClick={confirm}>
          Confirm receipt
        </button>
        <button type="button" className={buttonQuiet} disabled={busy} onClick={discard}>
          Discard draft
        </button>
        {problems.length > 0 && (
          <span className="text-sm text-stone-600">
            {problems.length} line{problems.length === 1 ? " needs" : "s need"} a product, a whole quantity and a cost — or untick it.
          </span>
        )}
        {message && <span className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</span>}
      </div>
    </div>
  );
}
