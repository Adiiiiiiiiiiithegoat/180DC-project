"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatPaise } from "@/lib/money";

// One series per chart, so one hue and no legend: the card title names it.
const SERIES = "#2a78d6";
// Revenue trend only, as the one chart accented with the brand colour —
// read from the single definition in globals.css, not retyped here. The
// darker shade for the line (bright green fails WCAG AA against white as a
// graphical stroke), bright green for the low-opacity fill beneath it.
const REVENUE_LINE = "var(--color-brand-green-dark)";
const REVENUE_FILL = "var(--color-brand-green)";
const GRID = "#e7e5e4"; // stone-200: recessive hairlines
const INK_MUTED = "#78716c"; // stone-500: axis text

/** Axis ticks only: ₹64k. Every exact figure is in the tooltip and the table. */
const compactRupees = (paise: number) => `₹${Math.round(paise / 100_000)}k`;

type TooltipProps = {
  active?: boolean;
  label?: string;
  payload?: { value?: number | string }[];
};

function ValueTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-stone-200 bg-white px-2.5 py-1.5 text-xs shadow-sm">
      <div className="font-semibold text-stone-900">{formatPaise(Number(payload[0].value))}</div>
      <div className="text-stone-500">{label}</div>
    </div>
  );
}

export type WeekPoint = { label: string; revenuePaise: number };

/** Weekly revenue, complete weeks only (the function drops partial ones). */
export function RevenueTrend({ weeks }: { weeks: WeekPoint[] }) {
  return (
    <div className="h-56" role="img" aria-label="Weekly revenue, complete weeks">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={weeks} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: INK_MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis
            tickFormatter={compactRupees}
            tick={{ fill: INK_MUTED, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip content={<ValueTooltip />} cursor={{ stroke: INK_MUTED, strokeWidth: 1 }} />
          <Area
            type="linear"
            dataKey="revenuePaise"
            stroke={REVENUE_LINE}
            strokeWidth={2}
            fill={REVENUE_FILL}
            fillOpacity={0.12}
            dot={false}
            activeDot={{ r: 4, fill: REVENUE_LINE, stroke: "#fff", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export type ProductBar = { name: string; revenuePaise: number };

/** Top products by revenue: horizontal bars, value at each tip. */
export function TopProducts({ products }: { products: ProductBar[] }) {
  return (
    <div className="h-56" role="img" aria-label="Top products by revenue">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={products} layout="vertical" margin={{ top: 0, right: 88, bottom: 0, left: 0 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={150}
            tick={{ fill: "#44403c", fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={<ValueTooltip />} cursor={{ fill: "#f5f5f4" }} />
          <Bar dataKey="revenuePaise" fill={SERIES} barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            <LabelList
              dataKey="revenuePaise"
              position="right"
              formatter={(v) => formatPaise(Number(v))}
              style={{ fill: "#1c1917", fontSize: 12 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
