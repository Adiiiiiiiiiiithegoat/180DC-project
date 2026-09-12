"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const WIDTH = 224; // matches the panel's w-56
const MARGIN = 8;

/**
 * A small "i" next to a metric's label, explaining it in plain language.
 * Hover (or keyboard focus) is the primary path; click pins it open
 * regardless of hover/focus, as a secondary path for touch or "let me keep
 * reading"; Escape or clicking elsewhere closes it.
 *
 * The panel is portaled to `document.body` and positioned with `fixed`
 * coordinates computed from the button's own position, clamped to the
 * viewport — not CSS `absolute`, because several of these sit inside a
 * horizontally-scrolling table wrapper (`overflow-x-auto`), and a plain
 * `overflow-x` value silently makes the browser clip the y-axis too (a
 * well-known CSS quirk), which would cut the panel off entirely there.
 * `fixed` escapes that clipping regardless of which container it's in.
 */
export function InfoTip({
  label,
  text,
  side = "top",
}: {
  label: string;
  text: string;
  /** Which side of the icon the panel opens toward — pick whichever side does
   * NOT have the number this metric describes (or another prominent number)
   * sitting right next to it. Defaults to "top", which is right for a card's
   * own heading; a label lower in the same card, with a bigger number just
   * above it, should use "bottom" instead. */
  side?: "top" | "bottom";
}) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: "top" | "bottom" } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const shown = hovered || pinned;

  useEffect(() => {
    if (!shown) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const left = Math.min(Math.max(r.left, MARGIN), window.innerWidth - WIDTH - MARGIN);
      // A rough height estimate, not a measured one — good enough to catch
      // the one case that matters: not enough room above to open "top"
      // without going off the top of the viewport, near the top of a page.
      const estimatedHeight = 130;
      const effectiveSide = side === "top" && r.top - MARGIN < estimatedHeight ? "bottom" : side;
      const top = effectiveSide === "top" ? r.top - MARGIN : r.bottom + MARGIN;
      setPos({ top, left, side: effectiveSide });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [shown, side]);

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPinned(false);
      btnRef.current?.blur();
    };
    const onOutside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !panelRef.current?.contains(t)) setPinned(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [pinned]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={shown}
        aria-describedby={id}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={() => setPinned((p) => !p)}
        className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-stone-400 align-middle text-[10px] font-semibold leading-none text-stone-500 hover:border-stone-600 hover:text-stone-700 focus:outline-none focus:ring-2 focus:ring-brand-green-dark focus:ring-offset-1"
      >
        i
      </button>
      {shown &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            style={{ position: "fixed", top: pos.top, left: pos.left, transform: pos.side === "top" ? "translateY(-100%)" : undefined }}
            className="z-50 w-56 rounded border border-stone-200 bg-white p-2 text-xs normal-case font-normal leading-snug tracking-normal text-stone-700 shadow-md"
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
