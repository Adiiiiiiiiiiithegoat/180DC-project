"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";
// Types only: erased at build, so nothing from these server modules (the
// tools, the Groq key, the database) is bundled for the browser.
import type { AssistantMessage } from "@/lib/assistant";
import type { Busy } from "@/lib/backoff";
import { formatPaise } from "@/lib/money";
import { button, buttonQuiet, input } from "./ui";

const TOOL_LABELS: Record<string, string> = {
  findProduct: "Looked up the product",
  getInventoryStatus: "Checked stock levels",
  getSalesSummary: "Summarised sales",
  getSalesTimeSeries: "Pulled the sales trend",
  getProductPerformance: "Compared products",
  getReorderSuggestions: "Worked out reorder points",
  getStockHistory: "Read the stock ledger",
};

const SUGGESTIONS = [
  "What's running low?",
  "How did the last 30 days go?",
  "Should I reorder Protein Bar Choco?",
  "What isn't selling?",
];

type SettingsPart = Extract<AssistantMessage["parts"][number], { type: "tool-updateProductSettings" }>;
type Product = { name: string; sku: string; reorderPoint: number; unitPrice: number; isActive: boolean };

export function Chat() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<Extract<Busy, { state: "waiting" }> & { until: number } | null>(null);

  const { messages, sendMessage, status, error, regenerate, addToolApprovalResponse } = useChat<AssistantMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    // After Approve / Decline, send the decision straight back so the server
    // can run (or skip) the write and the model can finish its answer.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onData: (part) => {
      if (part.type !== "data-busy") return;
      setBusy(part.data.state === "waiting" ? { ...part.data, until: Date.now() + part.data.seconds * 1000 } : null);
    },
  });

  const working = status === "submitted" || status === "streaming";
  useEffect(() => {
    if (!working) setBusy(null);
  }, [working]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: scrollIntoView returns a Promise in current browsers, and
    // an effect that returns one crashes React ("destroy is not a function").
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  function ask(question: string) {
    if (!question.trim() || working) return;
    sendMessage({ text: question.trim() });
    setText("");
  }

  return (
    <div className="flex flex-col gap-4" data-status={status}>
      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className={buttonQuiet} onClick={() => ask(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-4" aria-live="polite">
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="self-end max-w-[80%] rounded-lg bg-stone-900 px-3 py-2 text-sm text-white">
              {m.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
            </div>
          ) : (
            <div key={m.id} className="flex max-w-[90%] flex-col gap-2 text-sm">
              {m.parts.map((part, i) => {
                if (part.type === "text") return <Text key={i} text={part.text} />;
                if (part.type === "tool-updateProductSettings") {
                  return (
                    <SettingsChange
                      key={part.toolCallId}
                      part={part}
                      onDecide={(approved) => addToolApprovalResponse({ id: part.approval!.id, approved })}
                    />
                  );
                }
                if (isToolUIPart(part)) return <ToolChip key={part.toolCallId} part={part} />;
                return null; // reasoning and step boundaries stay out of the transcript
              })}
            </div>
          ),
        )}
      </div>

      {busy ? (
        <BusyNotice busy={busy} />
      ) : (
        status === "submitted" && <p className="text-sm text-stone-500">Thinking…</p>
      )}

      {error && (
        <div className="flex items-center gap-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>{error.message || "Something went wrong."}</span>
          <button type="button" className={buttonQuiet} onClick={() => regenerate()}>
            Try again
          </button>
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          ask(text);
        }}
      >
        <input
          className={`${input} flex-1`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about stock, sales or reorders…"
          aria-label="Ask the assistant"
          autoFocus
        />
        <button type="submit" className={button} disabled={working || !text.trim()}>
          Ask
        </button>
      </form>
      <div ref={end} />
    </div>
  );
}

/** Plain text; open models add **bold** whatever they are told, so render it rather than show asterisks. */
function Text({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap leading-relaxed">
      {text.split(/(\*\*[^*]+\*\*)/g).map((s, i) =>
        s.startsWith("**") && s.endsWith("**") ? <strong key={i}>{s.slice(2, -2)}</strong> : s,
      )}
    </p>
  );
}

/** Which tool ran, so the reader can see every figure came from the shop's data. */
function ToolChip({ part }: { part: Parameters<typeof getToolName>[0] & { state: string; errorText?: string } }) {
  const name = getToolName(part);
  const done = part.state === "output-available";
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 text-xs text-stone-600">
      <span aria-hidden>{part.state === "output-error" ? "✕" : done ? "✓" : "…"}</span>
      {TOOL_LABELS[name] ?? name}
      {part.state === "output-error" && <span className="text-red-700">: {part.errorText}</span>}
    </span>
  );
}

function BusyNotice({ busy }: { busy: { until: number; attempt: number } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((busy.until - now) / 1000));
  return (
    <div role="status" className="flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden />
      The model is busy (free-tier rate limit). Retrying {left > 0 ? `in ${left}s` : "now"}
      {busy.attempt > 1 ? `, attempt ${busy.attempt}` : ""}. Your question is still in progress.
    </div>
  );
}

/**
 * The one write. The proposed values are the model's; the current values are
 * fetched from the database by id, so the person approving sees what will
 * really change, not the model's description of it.
 */
function SettingsChange({ part, onDecide }: { part: SettingsPart; onDecide: (approved: boolean) => void }) {
  const [product, setProduct] = useState<Product | null>(null);
  const productId = part.input?.productId;
  useEffect(() => {
    if (!productId) return;
    fetch(`/api/products/${productId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setProduct)
      .catch(() => setProduct(null));
  }, [productId]);

  if (part.state === "input-streaming" || !part.input) {
    return <p className="text-xs text-stone-500">Preparing a change…</p>;
  }

  const rows: [string, string, string][] = [];
  const proposed = part.input;
  if (proposed.reorderPoint !== undefined) {
    rows.push(["Reorder point", product ? String(product.reorderPoint) : "…", String(proposed.reorderPoint)]);
  }
  if (proposed.unitPrice !== undefined) {
    rows.push(["Price", product ? formatPaise(product.unitPrice) : "…", formatPaise(proposed.unitPrice)]);
  }
  if (proposed.isActive !== undefined) {
    rows.push(["Active", product ? (product.isActive ? "yes" : "no") : "…", proposed.isActive ? "yes" : "no"]);
  }

  const outcome =
    part.state === "output-available"
      ? { text: "Approved and applied.", tone: "text-emerald-800" }
      : part.state === "output-denied"
        ? { text: "Declined. Nothing was changed.", tone: "text-stone-600" }
        : part.state === "output-error"
          ? { text: `Not applied: ${part.errorText}`, tone: "text-red-700" }
          : part.state === "approval-responded"
            ? { text: part.approval.approved ? "Approved, applying…" : "Declined.", tone: "text-stone-600" }
            : null;

  return (
    <div className="w-full max-w-md rounded-lg border border-amber-300 bg-white p-3" data-testid="approval-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Approval needed</p>
      <p className="mt-1 font-medium">
        {product ? `${product.name} (${product.sku})` : "Loading product…"}
      </p>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {rows.map(([field, now, next]) => (
            <tr key={field}>
              <td className="py-0.5 text-stone-500">{field}</td>
              <td className="py-0.5 text-right tabular-nums">{now}</td>
              <td className="px-2 py-0.5 text-stone-400">→</td>
              <td className="py-0.5 text-right font-semibold tabular-nums">{next}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {part.state === "approval-requested" ? (
        <div className="mt-3 flex gap-2">
          <button type="button" className={button} disabled={!product} onClick={() => onDecide(true)}>
            Approve
          </button>
          <button type="button" className={buttonQuiet} onClick={() => onDecide(false)}>
            Decline
          </button>
        </div>
      ) : (
        outcome && <p className={`mt-2 text-sm ${outcome.tone}`}>{outcome.text}</p>
      )}
    </div>
  );
}
