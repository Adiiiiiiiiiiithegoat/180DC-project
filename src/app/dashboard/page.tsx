import Link from "next/link";
import { RevenueTrend, TopProducts } from "@/components/dashboard-charts";
import { card, td, th } from "@/components/ui";
import {
  getInventoryStatus,
  getProductPerformance,
  getReorderSuggestions,
  getSalesSummary,
  getSalesTimeSeries,
} from "@/lib/analytics";
import { formatPaise } from "@/lib/money";
import { requireUserId } from "@/lib/session";

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * DESIGN.md section 9: four things, no more, each from one call to the same
 * function the assistant's tool calls. The revenue here and the assistant's
 * "revenue for the last 30 days" are the same getSalesSummary call, so they
 * cannot disagree.
 */
export default async function DashboardPage() {
  const userId = await requireUserId();
  const [summary, weekly, top, stock, reorder] = await Promise.all([
    getSalesSummary(userId, { days: 30 }),
    getSalesTimeSeries(userId, { granularity: "week", days: 90 }),
    getProductPerformance(userId, { days: 30, sortBy: "revenue", limit: 5 }),
    getInventoryStatus(userId),
    getReorderSuggestions(userId),
  ]);

  const change = "change" in summary ? summary.change.revenuePct : null;
  const attention = reorder.products.filter((p) => p.status === "reorder_now");
  const tooNew = reorder.products.filter((p) => p.status === "insufficient_history");

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* 1. Revenue over time: getSalesSummary for the headline, getSalesTimeSeries for the trend */}
      <section className={`${card} lg:col-span-2`} aria-labelledby="revenue-title">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="revenue-title" className="text-sm font-semibold">Revenue</h2>
          <span className="text-xs text-stone-500">
            Last 30 days: {shortDate(summary.period.from)} – {shortDate(summary.period.to)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
          <span className="text-4xl font-semibold tracking-tight" data-testid="revenue-30d">
            {formatPaise(summary.revenuePaise)}
          </span>
          {change !== null && (
            <span className={`text-sm ${change < 0 ? "text-red-700" : "text-emerald-700"}`}>
              {change < 0 ? "▼" : "▲"} {Math.abs(change)}% vs the 30 days before
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-stone-500">
          {summary.transactions} sales · gross margin {summary.grossMarginPct}%
        </p>

        <h3 className="mt-5 text-xs font-medium text-stone-600">Weekly revenue, complete weeks only</h3>
        <RevenueTrend
          weeks={weekly.points.map((w) => ({ label: shortDate(w.start), revenuePaise: w.revenuePaise }))}
        />
        <details className="mt-2 text-xs text-stone-600">
          <summary className="cursor-pointer">Show as a table</summary>
          <table className="mt-2">
            <thead>
              <tr>
                <th className={th}>Week</th>
                <th className={`${th} text-right`}>Revenue</th>
                <th className={`${th} text-right`}>Units</th>
              </tr>
            </thead>
            <tbody>
              {weekly.points.map((w) => (
                <tr key={w.start}>
                  <td className={td}>{shortDate(w.start)} – {shortDate(w.end)}</td>
                  <td className={`${td} text-right tabular-nums`}>{formatPaise(w.revenuePaise)}</td>
                  <td className={`${td} text-right tabular-nums`}>{w.units}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      {/* 2. Top products by revenue: getProductPerformance */}
      <section className={card} aria-labelledby="top-title">
        <h2 id="top-title" className="text-sm font-semibold">Top products by revenue</h2>
        <p className="mb-2 text-xs text-stone-500">Last 30 days</p>
        <TopProducts products={top.products.map((p) => ({ name: p.name, revenuePaise: p.revenuePaise }))} />
      </section>

      {/* 3. Stock value on hand: getInventoryStatus */}
      <section className={card} aria-labelledby="stock-title">
        <h2 id="stock-title" className="text-sm font-semibold">Stock value on hand</h2>
        <p className="mb-3 text-xs text-stone-500">At weighted average cost</p>
        <div className="text-4xl font-semibold tracking-tight">{formatPaise(stock.totals.stockValueAtCostPaise)}</div>
        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-stone-500">At retail price</dt>
          <dd className="text-right tabular-nums">{formatPaise(stock.totals.stockValueAtRetailPaise)}</dd>
          <dt className="text-stone-500">Units on hand</dt>
          <dd className="text-right tabular-nums">{stock.totals.unitsOnHand}</dd>
          <dt className="text-stone-500">Active products</dt>
          <dd className="text-right tabular-nums">{stock.totals.activeProducts}</dd>
          <dt className="text-stone-500">At or below reorder point</dt>
          <dd className="text-right tabular-nums">{stock.totals.atOrBelowReorderPoint}</dd>
        </dl>
      </section>

      {/* 4. Reorder attention: getReorderSuggestions, computed on page load */}
      <section className={`${card} lg:col-span-2`} aria-labelledby="reorder-title">
        <h2 id="reorder-title" className="text-sm font-semibold">Needs reordering</h2>
        <p className="mb-3 text-xs text-stone-500">
          On hand is at or below the suggested reorder point: mean daily sales over the last{" "}
          {reorder.method.trailingDays} days × lead time + {reorder.method.k} × standard deviation × √(lead time).
          k = {reorder.method.k} is roughly a 95% service level.
        </p>
        {attention.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing needs reordering.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-stone-200">
                <tr>
                  <th className={th}>Product</th>
                  <th className={`${th} text-right`}>On hand</th>
                  <th className={`${th} text-right`}>Sells / day</th>
                  <th className={`${th} text-right`}>Lead time</th>
                  <th className={`${th} text-right`}>Suggested reorder point</th>
                  <th className={`${th} text-right`}>Order</th>
                  <th className={`${th} text-right`}>Runs out in</th>
                </tr>
              </thead>
              <tbody>
                {attention.map((p) => (
                  <tr key={p.id} className="border-b border-stone-100">
                    <td className={td}>
                      <Link href={`/products/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{p.inputs?.onHand}</td>
                    <td className={`${td} text-right tabular-nums`}>{p.inputs?.meanDailyUnits}</td>
                    <td className={`${td} text-right tabular-nums`}>{p.inputs?.leadTimeDays}d</td>
                    <td className={`${td} text-right tabular-nums`}>{p.suggestedReorderPoint}</td>
                    <td className={`${td} text-right tabular-nums font-semibold`}>{p.suggestedOrderQuantity}</td>
                    <td className={`${td} text-right tabular-nums`}>
                      {p.daysToStockout === null ? "—" : `${p.daysToStockout} days`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tooNew.length > 0 && (
          <p className="mt-3 text-xs text-stone-500">
            Not enough history to suggest anything yet: {tooNew.map((p) => `${p.name} (${p.reason})`).join("; ")}.
          </p>
        )}
      </section>
    </div>
  );
}
