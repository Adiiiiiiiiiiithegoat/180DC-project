import Link from "next/link";
import { RevenueTrend, TopProducts } from "@/components/dashboard-charts";
import { InfoTip } from "@/components/info-tip";
import { card, link, td, th } from "@/components/ui";
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
 * DESIGN.md section 9: five things, no more, each from one call to the same
 * function the assistant's tool calls. The revenue here and the assistant's
 * "revenue for the last 30 days" are the same getSalesSummary call, so they
 * cannot disagree.
 */
export default async function DashboardPage() {
  const userId = await requireUserId();
  const [summary, weekly, top, rising, falling, stock, reorder] = await Promise.all([
    getSalesSummary(userId, { days: 30 }),
    getSalesTimeSeries(userId, { granularity: "week", days: 90 }),
    getProductPerformance(userId, { days: 30, sortBy: "revenue", limit: 5 }),
    getProductPerformance(userId, { days: 30, sortBy: "speeding_up", limit: 3 }),
    getProductPerformance(userId, { days: 30, sortBy: "slowing_down", limit: 3 }),
    getInventoryStatus(userId),
    getReorderSuggestions(userId),
  ]);
  // Only real movement: a product selling exactly as before is neither.
  const speedingUp = rising.products.filter((p) => p.units > p.previousUnits);
  const slowingDown = falling.products.filter((p) => p.units < p.previousUnits);

  const change = "change" in summary ? summary.change.revenuePct : null;
  const attention = reorder.products.filter((p) => p.status === "reorder_now");
  const tooNew = reorder.products.filter((p) => p.status === "insufficient_history");

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* 1. Revenue over time: getSalesSummary for the headline, getSalesTimeSeries for the trend */}
      <section className={`${card} lg:col-span-2`} aria-labelledby="revenue-title">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="revenue-title" className="text-sm font-semibold">
            Revenue
            <InfoTip
              label="Revenue"
              text="Total money taken from sales in the last 30 complete days, compared with the 30 days before that."
            />
          </h2>
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
        <p className="mt-1 flex flex-wrap items-center text-xs text-stone-500">
          {summary.transactions} sales
          <InfoTip
            label="Sales"
            text="How many separate sales (baskets rung up) happened in the last 30 days — not how many individual items were sold."
            side="bottom"
          />
          <span className="mx-1">·</span>
          gross margin {summary.grossMarginPct}%
          <InfoTip
            label="Gross margin"
            text="What's left of revenue after subtracting what the stock you sold cost you, as a percentage of revenue. This is before rent, wages and other running costs."
            side="bottom"
          />
        </p>

        <h3 className="mt-5 flex items-center text-xs font-medium text-stone-600">
          Weekly revenue, complete weeks only
          <InfoTip
            label="Weekly revenue chart"
            text="Revenue by week. A week that isn't fully finished yet (including this one) is left off, so the chart never shows a false dip for a week still in progress."
          />
        </h3>
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
                <th className={`${th} text-right`}>
                  Units
                  <InfoTip label="Units" text="Total items sold that week, across every product." />
                </th>
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
        <h2 id="top-title" className="text-sm font-semibold">
          Top products by revenue
          <InfoTip label="Top products by revenue" text="Your five highest-revenue products over the last 30 days." />
        </h2>
        <p className="mb-2 text-xs text-stone-500">Last 30 days</p>
        <TopProducts products={top.products.map((p) => ({ name: p.name, revenuePaise: p.revenuePaise }))} />
      </section>

      {/* 3. Stock value on hand: getInventoryStatus */}
      <section className={card} aria-labelledby="stock-title">
        <h2 id="stock-title" className="text-sm font-semibold">
          Stock value on hand
          <InfoTip
            label="Stock value on hand"
            text="What everything currently on the shelf cost you to buy, added up using each product's weighted average cost."
          />
        </h2>
        <p className="mb-3 text-xs text-stone-500">At weighted average cost</p>
        <div className="text-4xl font-semibold tracking-tight">{formatPaise(stock.totals.stockValueAtCostPaise)}</div>
        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="flex items-center text-stone-500">
            At retail price
            <InfoTip
              label="At retail price"
              text="What everything on the shelf would sell for at today's listed prices, if you sold all of it right now."
            />
          </dt>
          <dd className="text-right tabular-nums">{formatPaise(stock.totals.stockValueAtRetailPaise)}</dd>
          <dt className="flex items-center text-stone-500">
            Units on hand
            <InfoTip label="Units on hand" text="The total number of individual items across every active product, right now." />
          </dt>
          <dd className="text-right tabular-nums">{stock.totals.unitsOnHand}</dd>
          <dt className="flex items-center text-stone-500">
            Active products
            <InfoTip
              label="Active products"
              text="Products currently shown on the sale screen. Deactivated products — ones you've stopped selling — aren't counted."
            />
          </dt>
          <dd className="text-right tabular-nums">{stock.totals.activeProducts}</dd>
          <dt className="flex items-center text-stone-500">
            At or below reorder point
            <InfoTip
              label="At or below reorder point"
              text="How many products have fallen to, or below, the stock level where you said you'd want to reorder."
            />
          </dt>
          <dd className="text-right tabular-nums">{stock.totals.atOrBelowReorderPoint}</dd>
        </dl>
      </section>

      {/* 4. Fast and slow movers: getProductPerformance by change in units sold */}
      <section className={`${card} lg:col-span-2`} aria-labelledby="movers-title">
        <h2 id="movers-title" className="text-sm font-semibold">
          Movers
          <InfoTip
            label="Movers"
            text="The three products whose daily sales pace changed the most, up and down, comparing the last 30 days with the 30 before — ranked by size of change, not a fixed cutoff. A product with no change either way isn't listed."
          />
        </h2>
        <p className="mb-3 text-xs text-stone-500">
          Units sold per day, {top.period ? `${shortDate(top.period.from)} – ${shortDate(top.period.to)}` : "last 30 days"} against
          the 30 days before. Complete days only.
        </p>
        <div className="grid gap-6 sm:grid-cols-2">
          {[
            { title: "Speeding up", items: speedingUp, tone: "text-emerald-700", none: "Nothing is selling faster." },
            { title: "Slowing down", items: slowingDown, tone: "text-red-700", none: "Nothing is selling slower." },
          ].map((group) => (
            <div key={group.title}>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-stone-500">{group.title}</h3>
              {group.items.length === 0 ? (
                <p className="text-sm text-stone-500">{group.none}</p>
              ) : (
                <table className="w-full">
                  <tbody>
                    {group.items.map((p) => (
                      <tr key={p.id} className="border-b border-stone-100">
                        <td className={td}>
                          <Link href={`/products/${p.id}`} className={link}>{p.name}</Link>
                        </td>
                        <td className={`${td} text-right tabular-nums text-stone-500`}>{p.previousUnitsPerDay} → </td>
                        <td className={`${td} text-right tabular-nums font-medium`}>{p.unitsPerDay}/day</td>
                        <td className={`${td} text-right tabular-nums ${group.tone}`}>
                          {p.unitsChangePct === null ? "new" : `${p.unitsChangePct > 0 ? "+" : ""}${p.unitsChangePct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 5. Reorder attention: getReorderSuggestions, computed on page load */}
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
                  <th className={`${th} text-right`}>
                    On hand
                    <InfoTip label="On hand" text="How many units of this product are physically on the shelf right now." />
                  </th>
                  <th className={`${th} text-right`}>
                    Sells / day
                    <InfoTip
                      label="Sells per day"
                      text="The average number of units sold per day over the last 30 days. Used to work out when you'll run out and how much to reorder. It's a simple average, so one big one-off sale can pull it up."
                    />
                  </th>
                  <th className={`${th} text-right`}>
                    Lead time
                    <InfoTip
                      label="Lead time"
                      text="How many days it takes from placing an order with this supplier to the stock arriving. You set this yourself — it isn't calculated."
                    />
                  </th>
                  <th className={`${th} text-right`}>
                    Suggested reorder point
                    <InfoTip
                      label="Suggested reorder point"
                      text="An estimate, not a guarantee, of the stock level to reorder at — based on this product's sales over the last 30 days, its lead time, and a safety buffer for how much sales vary."
                    />
                  </th>
                  <th className={`${th} text-right`}>
                    Order
                    <InfoTip
                      label="Order"
                      text="An estimate, not a guarantee, of how many units to order now to reach the suggested reorder point."
                    />
                  </th>
                  <th className={`${th} text-right`}>
                    Runs out in
                    <InfoTip
                      label="Runs out in"
                      text="An estimate of how many days of stock are left, assuming sales keep going at about the recent average pace. Not a guarantee."
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {attention.map((p) => (
                  <tr key={p.id} className="border-b border-stone-100">
                    <td className={td}>
                      <Link href={`/products/${p.id}`} className={`font-medium ${link}`}>{p.name}</Link>
                      <div className="mt-0.5 text-xs text-stone-500">
                        Sells about {p.inputs?.meanDailyUnits}/day, {p.inputs?.leadTimeDays}-day lead time
                        {p.daysToStockout !== null && `, ~${p.daysToStockout} days of stock left`}
                      </div>
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
