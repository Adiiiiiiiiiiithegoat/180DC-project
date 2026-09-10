"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api-client";
import { formatPaise, paiseToInput, parseRupees } from "@/lib/money";
import {
  lineRevenue,
  priceBasket,
  selectPromotion,
  type PriceBasketResult,
  type Promotion,
} from "@/lib/pricing";
import { button, buttonQuiet, card, input, td, th } from "./ui";

export type SellableProduct = {
  id: string;
  name: string;
  sku: string;
  unitPrice: number;
  quantityOnHand: number;
};

export type LivePromotion = Omit<Promotion, "startsAt" | "endsAt"> & {
  startsAt: string;
  endsAt: string;
};

type Line = {
  key: string;
  productId: string;
  quantity: string;
  /**
   * null until the cashier edits it. An unedited line is priced from the
   * product by the SERVER at commit, so a price change since this page loaded
   * surfaces as price_changed rather than being silently charged at the old
   * number.
   */
  price: string | null;
};

const describe = (p: Promotion) =>
  p.type === "percent_off" ? `${p.percent}% off` : `Buy ${p.buyQty} get ${p.getQty} free`;

/**
 * DESIGN.md section 4, "The sale screen". Empty basket, focus already in the
 * search box. A barcode scanner is a keyboard, so a burst of characters ending
 * in Enter needs no special handling: Enter adds the line. Quantity and price
 * are editable inline; out-of-stock is blocked at the line, not on submit; and
 * the total names the promotion behind each discount.
 */
export function SaleScreen({
  products,
  promotions,
}: {
  products: SellableProduct[];
  promotions: LivePromotion[];
}) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("");
  // One key per basket (section 5, rule 3). A retry after a timeout sends the
  // same key, so the customer is never charged twice. Replaced only on success.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const promos = useMemo<Promotion[]>(
    () =>
      promotions.map((p) => ({ ...p, startsAt: new Date(p.startsAt), endsAt: new Date(p.endsAt) })),
    [promotions],
  );

  const q = query.trim().toLowerCase();
  // ponytail: filters the catalogue the page already holds — fine for a
  // shop-sized list; move to a server search if it grows past a few thousand.
  const matches = q
    ? products
        .filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
        .slice(0, 8)
    : [];

  function add(product: SellableProduct) {
    if (product.quantityOnHand === 0) {
      setStatus({ ok: false, text: `${product.name} is out of stock` });
      return;
    }
    setLines((ls) => {
      const existing = ls.find((l) => l.productId === product.id && l.price === null);
      if (existing) {
        const n = Number(existing.quantity) || 0;
        return ls.map((l) => (l === existing ? { ...l, quantity: String(n + 1) } : l));
      }
      return [...ls, { key: crypto.randomUUID(), productId: product.id, quantity: "1", price: null }];
    });
    setQuery("");
    setStatus(null);
    searchRef.current?.focus();
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // A scanner sends the exact SKU; typing picks the top match.
    const pick = products.find((p) => p.sku.toLowerCase() === q) ?? matches[0];
    if (pick) add(pick);
    else if (q) setStatus({ ok: false, text: `Nothing matches "${query}"` });
  }

  const update = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // Parse the editable fields, then work out each line's problem, if any.
  const parsed = lines.map((l) => {
    const product = byId.get(l.productId)!;
    // `qty`, not `quantity`: the raw string stays on the line for the input.
    const qty = /^\d+$/.test(l.quantity) && Number(l.quantity) > 0 ? Number(l.quantity) : null;
    const unitPrice = l.price === null ? product.unitPrice : parseRupees(l.price);
    return { ...l, product, qty, unitPrice };
  });
  // Stock is checked per product across every line for it — free units
  // included, because they leave the shelf too.
  const wanted = new Map<string, number>();
  for (const l of parsed) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + (l.qty ?? 0));
  const problems = parsed.map((l) => {
    if (l.qty === null) return "Enter a whole quantity";
    if (l.unitPrice === null) return "Price must look like 250 or 250.50";
    if (wanted.get(l.productId)! > l.product.quantityOnHand) {
      return `Only ${l.product.quantityOnHand} in stock`;
    }
    return null;
  });
  const discountPaise = discount.trim() === "" ? 0 : parseRupees(discount);

  let preview: PriceBasketResult | null = null;
  let previewError: string | null = null;
  if (parsed.length > 0 && problems.every((p) => p === null) && discountPaise !== null) {
    try {
      preview = priceBasket(
        parsed.map((l) => ({ productId: l.productId, quantity: l.qty!, unitPrice: l.unitPrice! })),
        promos,
        new Date(),
        discountPaise,
      );
    } catch (e) {
      previewError = (e as Error).message;
    }
  }

  async function charge() {
    if (!preview) return;
    setBusy(true);
    try {
      const sale = await api<{ id: string; total: number }>("/api/sales", "POST", {
        idempotencyKey,
        saleDiscount: discountPaise,
        // Section 5, rule 2: the server re-prices inside the transaction and
        // refuses if it disagrees with what the customer was shown.
        expectedTotal: preview.total,
        lines: parsed.map((l) => ({
          productId: l.productId,
          quantity: l.qty,
          ...(l.price === null ? {} : { unitPrice: l.unitPrice }),
        })),
      });
      setStatus({ ok: true, text: `Sale recorded: ${formatPaise(sale.total)}` });
      setLines([]);
      setDiscount("");
      setIdempotencyKey(crypto.randomUUID());
    } catch (e) {
      const err = e as ApiError;
      if (err.data?.error === "price_changed") {
        const total = (err.data.priced as { total: number }).total;
        setStatus({
          ok: false,
          text: `Prices changed since this screen loaded; the total is now ${formatPaise(total)}. Check the basket and charge again.`,
        });
      } else {
        setStatus({ ok: false, text: err.message });
      }
    } finally {
      setBusy(false);
      // Fresh stock levels and prices either way.
      router.refresh();
      searchRef.current?.focus();
    }
  }

  const now = new Date();
  // An empty basket totals zero; a basket with a blocked line has no total yet,
  // and showing 0.00 there would read as a real number.
  const shown = (paise: number | undefined) =>
    paise !== undefined ? formatPaise(paise) : parsed.length > 0 ? "—" : formatPaise(0);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <section className={card}>
        <div className="relative">
          <input
            ref={searchRef}
            autoFocus
            aria-label="Search products"
            placeholder="Scan or type a product name or SKU, then Enter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            className={`${input} w-full py-2 text-base`}
          />
          {matches.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded border border-stone-200 bg-white shadow">
              {matches.map((p, i) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={p.quantityOnHand === 0}
                    onClick={() => add(p)}
                    className={`flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-stone-100 disabled:text-stone-400 ${i === 0 ? "bg-stone-50" : ""}`}
                  >
                    <span>
                      {p.name} <span className="font-mono text-xs text-stone-500">{p.sku}</span>
                    </span>
                    <span className="tabular-nums">
                      {formatPaise(p.unitPrice)} · {p.quantityOnHand === 0 ? "out of stock" : `${p.quantityOnHand} left`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <table className="mt-4 w-full" data-testid="basket">
          <thead className="border-b border-stone-200">
            <tr>
              <th className={th}>Item</th>
              <th className={th}>Qty</th>
              <th className={th}>Price (₹)</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {parsed.map((l, i) => {
              const promo = selectPromotion(l.productId, promos, now);
              return (
                <tr
                  key={l.key}
                  className={`border-b border-stone-100 ${problems[i] ? "bg-red-50" : ""}`}
                >
                  <td className={td}>
                    <div className="font-medium">{l.product.name}</div>
                    <div className="text-xs text-stone-500">
                      {l.product.quantityOnHand} in stock
                      {promo && (
                        <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">
                          {describe(promo)}
                        </span>
                      )}
                    </div>
                    {problems[i] && (
                      <div role="alert" className="text-xs font-medium text-red-700">
                        {problems[i]}
                      </div>
                    )}
                  </td>
                  <td className={td}>
                    <input
                      aria-label={`Quantity of ${l.product.name}`}
                      inputMode="numeric"
                      value={l.quantity}
                      onChange={(e) => update(l.key, { quantity: e.target.value })}
                      className={`${input} w-20`}
                    />
                  </td>
                  <td className={td}>
                    <input
                      aria-label={`Price of ${l.product.name}`}
                      inputMode="decimal"
                      value={l.price ?? paiseToInput(l.product.unitPrice)}
                      onChange={(e) => update(l.key, { price: e.target.value })}
                      className={`${input} w-28`}
                    />
                  </td>
                  <td className={`${td} text-right`}>
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      className={buttonQuiet}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
            {parsed.length === 0 && (
              <tr>
                <td colSpan={4} className={`${td} py-8 text-center text-stone-400`}>
                  Basket is empty
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <aside className={`${card} flex h-fit flex-col gap-3`} data-testid="totals">
        <h2 className="text-sm font-semibold">Total</h2>
        {preview && (
          <ul className="flex flex-col gap-1 text-sm">
            {preview.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>
                  {l.quantity} × {byId.get(l.productId)!.name}
                  {l.isFreeUnit && <span className="ml-1 text-emerald-700">(free)</span>}
                </span>
                <span className="tabular-nums">{formatPaise(lineRevenue(l))}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-between border-t border-stone-200 pt-2 text-sm">
          <span>Subtotal</span>
          <span className="tabular-nums">{shown(preview?.subtotal)}</span>
        </div>
        {preview?.discounts.map((d, i) => (
          <div key={i} className="flex justify-between text-sm text-emerald-700" data-testid="discount">
            <span>
              {d.label}
              {d.productId && ` · ${byId.get(d.productId)?.name}`}
            </span>
            <span className="tabular-nums">−{formatPaise(d.amount)}</span>
          </div>
        ))}
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>Sale discount (₹)</span>
          <input
            aria-label="Sale discount"
            inputMode="decimal"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            placeholder="0"
            className={`${input} w-24 text-right`}
          />
        </label>
        {discountPaise === null && <p className="text-xs text-red-700">Discount must look like 10 or 10.50</p>}
        <div className="flex justify-between border-t border-stone-200 pt-2 text-lg font-semibold">
          <span>Total</span>
          <span className="tabular-nums" data-testid="total">{shown(preview?.total)}</span>
        </div>
        {!preview && parsed.length > 0 && !previewError && (
          <p className="text-xs text-stone-500">Fix the highlighted line to see the total.</p>
        )}
        {previewError && <p className="text-xs text-red-700">{previewError}</p>}
        <button type="button" disabled={!preview || busy} onClick={charge} className={`${button} py-2.5`}>
          Charge {preview ? formatPaise(preview.total) : ""}
        </button>
        {status && (
          <p role="status" className={`text-sm ${status.ok ? "text-emerald-700" : "text-red-700"}`}>
            {status.text}
          </p>
        )}
      </aside>
    </div>
  );
}
