import { notFound } from "next/navigation";
import { ActiveToggle } from "@/components/active-toggle";
import { InfoTip } from "@/components/info-tip";
import { ProductForm } from "@/components/product-form";
import { PromotionForm } from "@/components/promotion-form";
import { card, td, th } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getProduct, listPromotionsForProduct, listRecentMovements } from "@/lib/queries";
import { requireUserId } from "@/lib/session";

const when = (d: Date) =>
  d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function describe(p: { type: string; percent: number | null; buyQty: number | null; getQty: number | null }) {
  return p.type === "percent_off" ? `${p.percent}% off` : `Buy ${p.buyQty} get ${p.getQty} free`;
}

export default async function ProductPage({ params }: PageProps<"/products/[id]">) {
  const userId = await requireUserId();
  const { id } = await params;
  // Another account's product id resolves to nothing, exactly like a typo.
  const product = await getProduct(userId, id);
  if (!product) notFound();

  const [promos, movements] = await Promise.all([
    listPromotionsForProduct(userId, id),
    listRecentMovements(userId, id),
  ]);
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <section className={card}>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <h1 className="text-lg font-semibold">{product.name}</h1>
          <span className="font-mono text-xs text-stone-500">{product.sku}</span>
          <span className="text-sm">
            On hand <strong data-testid="on-hand" className="tabular-nums">{product.quantityOnHand}</strong>
            <InfoTip label="On hand" text="How many units of this product are physically on the shelf right now." />
          </span>
          <span className="text-sm">
            Avg cost <strong className="tabular-nums">{formatPaise(product.averageCost)}</strong>
            <InfoTip
              label="Average cost"
              text="The average price you've paid for this product's stock, weighted by how much arrived at each price — so a big cheap delivery counts for more than a small pricey one. Used to work out margin."
            />
          </span>
          <span className="text-sm">
            Stock value{" "}
            <strong className="tabular-nums">
              {formatPaise(product.quantityOnHand * product.averageCost)}
            </strong>
            <InfoTip label="Stock value" text="What this product's stock currently on the shelf cost you: units on hand × average cost." />
          </span>
          <span className="ml-auto">
            <ActiveToggle
              path={`/api/products/${product.id}`}
              isActive={product.isActive}
              activeLabel="Deactivate"
              inactiveLabel="Reactivate"
            />
          </span>
        </div>
        {!product.isActive && (
          <p className="mt-2 text-sm text-amber-700">
            Deactivated: hidden from the sale screen, kept for history.
          </p>
        )}
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold">Settings</h2>
        <ProductForm initial={product} />
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold">Promotions</h2>
        <table className="mb-4 w-full">
          <thead className="border-b border-stone-200">
            <tr>
              <th className={th}>Rule</th>
              <th className={th}>Priority</th>
              <th className={th}>Window</th>
              <th className={th}>Status</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {promos.map((p) => {
              const status = !p.isActive
                ? "ended"
                : p.endsAt < now
                  ? "expired"
                  : p.startsAt > now
                    ? "scheduled"
                    : "live";
              return (
                <tr key={p.id} className="border-b border-stone-100">
                  <td className={td}>{describe(p)}</td>
                  <td className={`${td} tabular-nums`}>{p.priority}</td>
                  <td className={td}>
                    {when(p.startsAt)} → {when(p.endsAt)}
                  </td>
                  <td className={td}>{status}</td>
                  <td className={`${td} text-right`}>
                    {p.isActive && (
                      <ActiveToggle
                        path={`/api/promotions/${p.id}`}
                        isActive
                        activeLabel="End"
                        inactiveLabel=""
                      />
                    )}
                  </td>
                </tr>
              );
            })}
            {promos.length === 0 && (
              <tr>
                <td colSpan={5} className={`${td} text-stone-500`}>No promotions.</td>
              </tr>
            )}
          </tbody>
        </table>
        <PromotionForm productId={product.id} />
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold">Stock ledger (latest 25)</h2>
        <table className="w-full" data-testid="ledger">
          <thead className="border-b border-stone-200">
            <tr>
              <th className={th}>When</th>
              <th className={th}>Reason</th>
              <th className={`${th} text-right`}>Quantity</th>
              <th className={th}>Note</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id} className="border-b border-stone-100">
                <td className={td}>{when(m.createdAt)}</td>
                <td className={td}>{m.reason}</td>
                <td
                  className={`${td} text-right tabular-nums ${m.quantity < 0 ? "text-red-700" : "text-emerald-700"}`}
                >
                  {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                </td>
                <td className={`${td} text-stone-500`}>{m.note}</td>
              </tr>
            ))}
            {movements.length === 0 && (
              <tr>
                <td colSpan={4} className={`${td} text-stone-500`}>No movements yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
