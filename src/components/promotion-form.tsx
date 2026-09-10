"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api-client";
import { button, input, label } from "./ui";

const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function PromotionForm({ productId }: { productId: string }) {
  const router = useRouter();
  const [type, setType] = useState<"percent_off" | "buy_x_get_y">("buy_x_get_y");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [now] = useState(() => new Date());

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const num = (k: string) => Number(form.get(k));
    try {
      await api("/api/promotions", "POST", {
        productId,
        type,
        percent: type === "percent_off" ? num("percent") : null,
        buyQty: type === "buy_x_get_y" ? num("buyQty") : null,
        getQty: type === "buy_x_get_y" ? num("getQty") : null,
        priority: num("priority"),
        startsAt: new Date(String(form.get("startsAt"))).toISOString(),
        endsAt: new Date(String(form.get("endsAt"))).toISOString(),
      });
      setMessage({ ok: true, text: "Promotion added" });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <label className={label}>
        Rule
        <select
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          className={input}
        >
          <option value="buy_x_get_y">Buy X get Y free</option>
          <option value="percent_off">Percent off</option>
        </select>
      </label>
      {type === "percent_off" ? (
        <label className={label}>
          Percent
          <input
            name="percent"
            type="number"
            min={1}
            max={100}
            required
            defaultValue={10}
            className={`${input} w-20`}
          />
        </label>
      ) : (
        <>
          <label className={label}>
            Buy
            <input name="buyQty" type="number" min={1} required defaultValue={2} className={`${input} w-16`} />
          </label>
          <label className={label}>
            Get free
            <input name="getQty" type="number" min={1} required defaultValue={1} className={`${input} w-16`} />
          </label>
        </>
      )}
      <label className={label}>
        Priority (0 first)
        <input name="priority" type="number" required defaultValue={0} className={`${input} w-20`} />
      </label>
      <label className={label}>
        Starts
        <input
          name="startsAt"
          type="datetime-local"
          required
          defaultValue={toLocalInput(now)}
          className={input}
        />
      </label>
      <label className={label}>
        Ends
        <input
          name="endsAt"
          type="datetime-local"
          required
          defaultValue={toLocalInput(new Date(now.getTime() + 30 * 86_400_000))}
          className={input}
        />
      </label>
      <button type="submit" className={button}>
        Add promotion
      </button>
      {message && (
        <span className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>
          {message.text}
        </span>
      )}
    </form>
  );
}
