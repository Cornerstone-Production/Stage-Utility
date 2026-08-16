// The one widget idiom: caption, value, sub-line, sized from the box it is in.
//
//   CAPTION           uppercase, letterspaced, ~55% opacity
//   0:04:12           the value — mono + tabular for numbers, sans for words
//   OBS + REAPER      the sub-line: what it is, or the qualifier
//
// This is the composition the Home stat cards use, lifted out so a stage display
// and a dashboard tile draw the SAME widget rather than two designs that happen
// to show the same number. Phase 7 Task 9.
//
// The first attempt at this was a `compact` flag on the render context that Home
// set and displays did not. That produced two idioms — which is the opposite of
// the ask — and was reverted before it shipped. The style is not a mode; it is
// the style, so it lives in one component with no caller-side variant.
//
// SIZED FROM THE BOX, not from a stored font size. All three lines derive from
// the widget's own height, so a readout is legible at whatever size it is placed
// at without anybody tuning a number. That is what makes the per-object font-size
// field pointless rather than merely unavailable — the order the standing rule
// requires before a knob comes out.

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  CAPTION_SCALE, CAPTION_MIN_PX, SUB_SCALE, SUB_MIN_PX, GAP_SCALE,
  CAPTION_LEADING, VALUE_LEADING, SUB_LEADING, valueSizeFor,
} from "./readout-size";
import { useLatestRef } from "@renderer/lib/use-latest-ref";

/**
 * The height of the box this readout sits in, in LAYOUT pixels.
 *
 * offsetHeight rather than getBoundingClientRect: a scaled canvas — the editor
 * preview, a display fit to its window — applies a CSS transform, and a rect is
 * measured after it. Deriving a font size from a post-transform number and then
 * letting the same transform scale the text again applies the scale twice.
 *
 * Measures the PARENT, which is the object's positioned box, so the proportions
 * are the ones the comparison page was approved at: those are shares of the
 * widget's outer height, padding included.
 */
function useBoxHeight(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return;
    const measure = () =>
      setH((prev) => (Math.abs(box.offsetHeight - prev) > 0.5 ? box.offsetHeight : prev));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  return [ref, h];
}

/**
 * Shrink the value so it fits the box's WIDTH. Shrink only — never grow.
 *
 * The height is what sets the size; this is the escape hatch for the case the
 * height cannot see, which is a long value in a wide-but-short box ("11:59:59 PM"
 * in a 1x1 tile). Letting it grow as well would put the width back in charge and
 * undo the whole point of sizing from the box.
 */
function useShrinkToWidth(deps: unknown[]): {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  elRef: React.RefObject<HTMLSpanElement | null>;
  scale: number;
} {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const elRef = useRef<HTMLSpanElement | null>(null);
  const [scale, setScale] = useState(1);
  // The observer subscribes once per dep change, so its callback would otherwise
  // close over a stale `scale` and converge to the wrong number. Written in an
  // effect, never during render — the same rule that caught the first attempt at
  // Home's pending-edit ref.
  const scaleRef = useLatestRef(scale);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const el = elRef.current;
    if (!wrap || !el) return;
    const measure = () => {
      const avail = wrap.clientWidth;
      if (avail <= 1) return;
      const cur = scaleRef.current;
      const natural = el.scrollWidth / cur;
      if (natural <= 0) return;
      // Floor at 0.35 so a pathological string degrades to "small" rather than
      // to "invisible" — an unreadable value is the same as no value.
      const want = Math.max(0.35, Math.min(1, avail / natural));
      if (Math.abs(want - cur) > 0.01) setScale(want);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { wrapRef, elRef, scale };
}

export interface ReadoutProps {
  /** What this is — "SERVICE STARTS IN", "OBS". Absent on objects that predate
   *  captions, in which case the composition is value + sub. */
  caption?: string | null;
  /** The value. A string in almost every case; ReactNode for the few that carry
   *  a glyph beside it (RF bars, a status dot). */
  value: ReactNode;
  /** The qualifier under the value — a timecode, a source, a count. */
  sub?: string | null;
  /** Colour for the value when it carries a state: over, behind, recording. */
  valueColor?: string | null;
  /**
   * Paint the whole card in a state colour, white text on it.
   *
   * The filled variant, not a second design language. OBS and REAPER paint a
   * solid red panel while recording and that stays — it is a see-it-across-the-
   * room signal and it works. What changes is that the fill now carries the same
   * caption/value/sub structure as every other widget, so a filled widget is the
   * same widget wearing a state.
   */
  fill?: string | null;
  /** Mono + tabular figures. For values that are NUMBERS which change while you
   *  watch them: proportional digits are different widths, so the text physically
   *  moves every tick, which is the one thing a wall readout must not do. */
  mono?: boolean;
  /** Weight for the value. Defaults to 600; the filled variant goes to 700. */
  weight?: number;
}

/**
 * One readout, in the idiom.
 *
 * LEFT-ALIGNED as part of the composition rather than as a default the stored
 * `textAlign` can override. Three stacked lines of different sizes only read as
 * one object when they share an edge; centred, they read as three things that
 * happen to be near each other. This does move existing layouts, which is the
 * point of the change — the alignment field goes on governing the text objects
 * (plain text, slide text, notes, service order), where it is doing real work.
 */
export function Readout({
  caption,
  value,
  sub,
  valueColor,
  fill,
  mono = false,
  weight,
}: ReadoutProps) {
  const [ref, boxH] = useBoxHeight();
  const captionPx = caption ? Math.max(CAPTION_MIN_PX, boxH * CAPTION_SCALE) : 0;
  const subPx = sub ? Math.max(SUB_MIN_PX, boxH * SUB_SCALE) : 0;
  const valuePx = valueSizeFor(boxH, captionPx, subPx);
  const { wrapRef, elRef, scale } = useShrinkToWidth([value, valuePx, mono]);

  const filled = !!fill;
  const captionStyle: CSSProperties = {
    fontSize: `${captionPx}px`,
    fontWeight: 600,
    letterSpacing: "0.09em",
    textTransform: "uppercase",
    // Its own face, never the value's: a caption is words, and the mono a
    // numeric readout uses makes words worse.
    color: filled ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.55)",
    lineHeight: CAPTION_LEADING,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 0,
    width: "100%",
  };
  const subStyle: CSSProperties = {
    fontSize: `${subPx}px`,
    color: filled ? "rgba(255,255,255,0.80)" : "rgba(255,255,255,0.45)",
    lineHeight: SUB_LEADING,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 0,
    width: "100%",
  };

  return (
    <div
      ref={ref}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-start",
        gap: `${boxH * GAP_SCALE}px`,
        overflow: "hidden",
        minHeight: 0,
        // Inherited so the fill below can inherit it in turn — the ground has to
        // be the same shape as the object or its corners sit proud of them.
        borderRadius: "inherit",
      }}
    >
      {/* The filled ground.
          ABSOLUTE against the OBJECT's box, not sized to this one: the nearest
          positioned ancestor is the object wrapper, so inset:0 covers the
          object's padding too. A ground that stops at the content box leaves the
          object's own background drawing a ring around it — the exact bug the
          recording fill was rewritten to avoid. */}
      {filled ? (
        <span
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, background: fill!, borderRadius: "inherit" }}
        />
      ) : null}
      {caption ? <span style={{ ...captionStyle, position: "relative" }}>{caption}</span> : null}
      <div ref={wrapRef} style={{ width: "100%", minHeight: 0, overflow: "hidden", position: "relative" }}>
        <span
          ref={elRef}
          style={{
            display: "inline-block",
            fontSize: `${valuePx * scale}px`,
            fontWeight: weight ?? (filled ? 700 : 600),
            // Explicit, never inherited: these render on a themed page as well as
            // on a display, and an inherited colour resolved to black on black
            // there once — measured at 1.06:1.
            color: filled ? "#ffffff" : valueColor ?? "rgba(255,255,255,0.92)",
            lineHeight: VALUE_LEADING,
            whiteSpace: "nowrap",
            ...(mono ? { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" } : null),
          }}
        >
          {value}
        </span>
      </div>
      {sub ? (
        <span style={{ ...subStyle, position: "relative" }} title={sub}>
          {sub}
        </span>
      ) : null}
    </div>
  );
}
