"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { button, input } from "./ui";

type State =
  | { step: "idle" }
  | { step: "reading" }
  | { step: "waiting"; until: number; attempt: number }
  | { step: "error"; message: string };

const MAX_AUTO_RETRIES = 3;

/**
 * DESIGN.md section 3, step 1. Upload a photo or PDF of a delivery note; the
 * server reads it into a draft and we go to the review screen. Nothing is
 * received until that screen is confirmed.
 *
 * A 429 is the free tier asking us to wait: we show the countdown from its
 * Retry-After and try again ourselves, so an upload never just fails quietly.
 */
export function UploadNote() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>({ step: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const formRef = useRef<HTMLFormElement>(null);

  async function send(f: File, attempt = 0) {
    setState({ step: "reading" });
    const body = new FormData();
    body.set("file", f);
    try {
      const res = await fetch("/api/receipts/drafts", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        router.push(`/receive/drafts/${data.id}`);
        return;
      }
      if (res.status === 429 && attempt < MAX_AUTO_RETRIES) {
        const seconds = Number(res.headers.get("retry-after") ?? data.retryAfterSeconds ?? 30);
        setState({ step: "waiting", until: Date.now() + seconds * 1000, attempt: attempt + 1 });
        return;
      }
      setState({ step: "error", message: data.message ?? `Upload failed (${res.status})` });
    } catch {
      setState({ step: "error", message: "The upload did not reach the server. Check the connection and try again." });
    }
  }

  // Count down a rate-limit wait, then retry the same file.
  useEffect(() => {
    if (state.step !== "waiting") return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= state.until && file) {
        clearInterval(t);
        void send(file, state.attempt);
      }
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, file]);

  return (
    <form
      ref={formRef}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (file) void send(file);
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          name="file"
          aria-label="Delivery note photo or PDF"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className={`${input} max-w-full`}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setState({ step: "idle" });
          }}
        />
        <button type="submit" className={button} disabled={!file || state.step === "reading" || state.step === "waiting"}>
          Read delivery note
        </button>
      </div>
      <p className="text-xs text-stone-500">
        A photo (JPEG, PNG, WebP) or a PDF, up to 20 MB. It is read into a draft for you to check; nothing is received
        until you confirm, and the file itself is not kept.
      </p>
      <div aria-live="polite">
        {state.step === "reading" && <p className="text-sm text-stone-600">Reading the document… usually a few seconds.</p>}
        {state.step === "waiting" && (
          <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The document reader is at its free-tier limit. Trying again in{" "}
            {Math.max(0, Math.ceil((state.until - now) / 1000))}s (attempt {state.attempt} of {MAX_AUTO_RETRIES}).
          </p>
        )}
        {state.step === "error" && (
          <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
