"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
import { paiseToInput, parseRupees } from "@/lib/money";
import { InfoTip } from "./info-tip";
import { button, input, label } from "./ui";

type Initial = {
  id: string;
  name: string;
  sku: string;
  category: string | null;
  unitPrice: number;
  reorderPoint: number;
  leadTimeDays: number;
};

/** Create when `initial` is absent, edit when present. Never touches stock or cost. */
export function ProductForm({ initial }: { initial?: Initial }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const unitPrice = parseRupees(String(form.get("price")));
    if (unitPrice === null) {
      setMessage({ ok: false, text: "Price must look like 250 or 250.50" });
      return;
    }
    const body = {
      name: String(form.get("name")),
      sku: String(form.get("sku")),
      category: String(form.get("category")).trim() || null,
      unitPrice,
      reorderPoint: Number(form.get("reorderPoint")),
      leadTimeDays: Number(form.get("leadTimeDays")),
    };
    setBusy(true);
    try {
      if (initial) {
        await api(`/api/products/${initial.id}`, "PATCH", body);
        setMessage({ ok: true, text: "Saved" });
      } else {
        await api("/api/products", "POST", body);
        formEl.reset();
        setMessage({ ok: true, text: `Added ${body.name}` });
      }
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-2 gap-3 md:grid-cols-7 md:items-end">
      <label className={`${label} col-span-2`}>
        Name
        <input name="name" required defaultValue={initial?.name} className={input} />
      </label>
      <label className={label}>
        SKU
        <input name="sku" required defaultValue={initial?.sku} className={input} />
      </label>
      <label className={label}>
        Category
        <input name="category" defaultValue={initial?.category ?? ""} className={input} />
      </label>
      <label className={label}>
        Price (₹)
        <input
          name="price"
          required
          inputMode="decimal"
          defaultValue={initial ? paiseToInput(initial.unitPrice) : ""}
          className={input}
        />
      </label>
      <label className={label}>
        <span className="flex items-center">
          Reorder point
          <InfoTip
            label="Reorder point"
            text="The stock level you choose as your own cue to reorder this product. It doesn't update itself — you set it."
          />
        </span>
        <input
          name="reorderPoint"
          type="number"
          min={0}
          required
          defaultValue={initial?.reorderPoint ?? 0}
          className={input}
        />
      </label>
      <label className={label}>
        <span className="flex items-center">
          Lead time (days)
          <InfoTip
            label="Lead time"
            text="How many days it takes from placing an order with this supplier to the stock arriving. Used to work out the suggested reorder point."
          />
        </span>
        <input
          name="leadTimeDays"
          type="number"
          min={0}
          required
          defaultValue={initial?.leadTimeDays ?? 7}
          className={input}
        />
      </label>
      <div className="col-span-2 flex items-center gap-3 md:col-span-7">
        <button type="submit" disabled={busy} className={button}>
          {initial ? "Save changes" : "Add product"}
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
