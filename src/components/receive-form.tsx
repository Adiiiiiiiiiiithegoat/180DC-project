"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
import { formatPaise, paiseToInput, parseRupees } from "@/lib/money";
import { button, buttonQuiet, input, label, td, th } from "./ui";

type Product = {
  id: string;
  name: string;
  sku: string;
  quantityOnHand: number;
  averageCost: number;
};

type Line = { key: string; productId: string; quantity: string; unitCost: string };

const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

/**
 * DESIGN.md section 3: header (supplier, their note reference, date received)
 * and lines (product, quantity counted, unit cost). The quantity is what a
 * human counted, not what the delivery note claims.
 */
export function ReceiveForm({
  products,
  suppliers,
}: {
  products: Product[];
  suppliers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const byId = new Map(products.map((p) => [p.id, p]));
  const blank = (): Line => ({ key: crypto.randomUUID(), productId: "", quantity: "", unitCost: "" });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const parsed = lines.map((l) => ({
      productId: l.productId,
      quantity: /^\d+$/.test(l.quantity) ? Number(l.quantity) : 0,
      unitCost: parseRupees(l.unitCost),
    }));
    const bad = parsed.findIndex((l) => !l.productId || l.quantity <= 0 || l.unitCost === null);
    if (bad > -1) {
      setMessage({ ok: false, text: `Line ${bad + 1}: pick a product, a whole quantity, and a cost like 80 or 80.50` });
      return;
    }
    setBusy(true);
    try {
      await api("/api/receipts", "POST", {
        supplierName: String(form.get("supplier")).trim() || undefined,
        reference: String(form.get("reference")).trim() || undefined,
        receivedAt: String(form.get("receivedAt")),
        lines: parsed,
      });
      const units = parsed.reduce((s, l) => s + l.quantity, 0);
      setMessage({ ok: true, text: `Received ${units} units on ${parsed.length} line(s)` });
      setLines([blank()]);
      formEl.reset();
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <label className={label}>
          Supplier
          <input name="supplier" list="suppliers" className={input} placeholder="e.g. Metro Wholesale" />
          <datalist id="suppliers">
            {suppliers.map((s) => (
              <option key={s.id} value={s.name} />
            ))}
          </datalist>
        </label>
        <label className={label}>
          Delivery note ref
          <input name="reference" className={input} />
        </label>
        <label className={label}>
          Date received
          <input name="receivedAt" type="date" required defaultValue={today()} className={input} />
        </label>
      </div>

      <table className="w-full">
        <thead className="border-b border-stone-200">
          <tr>
            <th className={th}>Product</th>
            <th className={th}>Now on hand</th>
            <th className={th}>Qty counted</th>
            <th className={th}>Unit cost (₹)</th>
            <th className={th}></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const p = byId.get(l.productId);
            return (
              <tr key={l.key} className="border-b border-stone-100">
                <td className={td}>
                  <select
                    aria-label="Product"
                    value={l.productId}
                    onChange={(e) => {
                      const next = byId.get(e.target.value);
                      update(l.key, {
                        productId: e.target.value,
                        // Pre-fill last known average cost; the delivery note's
                        // cost is what should actually be typed here.
                        unitCost: next && !l.unitCost ? paiseToInput(next.averageCost) : l.unitCost,
                      });
                    }}
                    className={`${input} w-64`}
                  >
                    <option value="">Choose…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.sku})
                      </option>
                    ))}
                  </select>
                </td>
                <td className={`${td} tabular-nums text-stone-500`}>
                  {p ? `${p.quantityOnHand} @ avg ${formatPaise(p.averageCost)}` : "—"}
                </td>
                <td className={td}>
                  <input
                    aria-label="Quantity"
                    inputMode="numeric"
                    value={l.quantity}
                    onChange={(e) => update(l.key, { quantity: e.target.value })}
                    className={`${input} w-24`}
                  />
                </td>
                <td className={td}>
                  <input
                    aria-label="Unit cost"
                    inputMode="decimal"
                    value={l.unitCost}
                    onChange={(e) => update(l.key, { unitCost: e.target.value })}
                    className={`${input} w-28`}
                  />
                </td>
                <td className={`${td} text-right`}>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      className={buttonQuiet}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setLines((ls) => [...ls, blank()])} className={buttonQuiet}>
          Add line
        </button>
        <button type="submit" disabled={busy} className={button}>
          Confirm receipt
        </button>
        {message && (
          <span className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>
            {message.text}
          </span>
        )}
      </div>
    </form>
  );
}
