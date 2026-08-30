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
  GAP_SCALE, CAPTION_LEADING, VALUE_LEADING, SUB_LEADING, PAD_SCALE, fitComposition,
} from "./readout-size";
import { DEFAULT_READOUT_ALIGN } from "@main/types/readout-types";
import type { LayoutHAlign } from "@main/types/views";
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
function useBoxSize(): [React.RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ h: 0, w: 0 });
  useLayoutEffect(() => {
    // The READOUT's own box, not the object's outer one. It is positioned
    // inset:0, which resolves against the object's PADDING box — so an object
    // carrying stored padding gives the composition less room than the object's
    // height, and sizing from the outer height overran it by exactly that
    // padding. A card preset's 16px a side is invisible on a big widget and
    // clips a small one, which is why this only ever showed up on the ones
    // somebody had shrunk.
    const box = ref.current;
    if (!box) return;
    const measure = () =>
      setSize((prev) =>
        Math.abs(box.offsetHeight - prev.h) > 0.5 || Math.abs(box.offsetWidth - prev.w) > 0.5
          ? { h: box.offsetHeight, w: box.offsetWidth }
          : prev,
      );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  return [ref, size.h, size.w];
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

/**
 * The three pieces of a line that carries an end slot.
 *
 * Written once rather than inline twice: the caption row and the sub-line row
 * are the same shape, and the first version of them had drifted apart before it
 * was even reviewed.
 */
const ROW: CSSProperties = { display: "flex", alignItems: "baseline", gap: "0.6em" };
const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };
const END_SLOT: CSSProperties = {
  marginLeft: "auto",
  flexShrink: 0,
  // Its own case and spacing: a state word set in the caption's caps and
  // letterspacing reads as a second caption rather than as a reading.
  textTransform: "none",
  letterSpacing: "0.02em",
};

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
  /**
   * Size the value as though the composition had all three lines.
   *
   * For a GRID of same-height tiles — Home. A tile that carries no caption and
   * no sub-line otherwise takes the whole budget, which put the clock at 52px in
   * a row of 35px values. On a wall a widget is placed alone at a size somebody
   * chose, so filling the box stays right there and this stays off.
   */
  uniform?: boolean;
  /**
   * Uppercase the value.
   *
   * For values that are WORDS naming a state — RECORDING, STANDBY, ONLINE. A
   * state reads as a state in caps and as prose in sentence case, and these are
   * read at a glance from across a room. Never for numbers, where it does
   * nothing, and never for content the operator wrote as a sentence.
   */
  upper?: boolean;
  /**
   * How the three lines align against each other.
   *
   * Defaults to left, which is what makes the composition read as one object.
   * Honoured rather than fixed, because a custom view legitimately wants a
   * centred clock as a centrepiece — the first cut of this idiom hard-coded left
   * and silently broke the alignment control for every readout.
   */
  align?: LayoutHAlign | null;
  /**
   * Dim the whole composition.
   *
   * For a widget that cannot report — an integration that is unreachable, a
   * recorder that is offline. Dimming the readout rather than showing a
   * confident neutral value is what stops "not recording" being read off a
   * device that is merely unplugged.
   */
  dim?: boolean;
  /**
   * The right end of the CAPTION row — a short state word, as Home's Readiness
   * header already uses for "2 to sort out".
   *
   * Costs no height: the caption line exists either way and this rides in it, so
   * it is not in `fitComposition`'s budget. Drawn only when the caption is, so it
   * cannot float alone over a value in a box too short for a caption.
   *
   * A ReactNode rather than a `{ text, color }` shape: this is a slot, and what
   * a state word should look like belongs to the widget that knows what state it
   * is reporting, not to the composition.
   */
  captionEnd?: ReactNode;
  /** The right end of the SUB-LINE — the number the sub-line names. Rides in the
   *  sub-line, so it also costs no height. */
  subEnd?: ReactNode;
  /** 0..1. A hairline progress rule under the sub-line. Null draws nothing.
   *  Unlike the two slots above this DOES take height, so it is budgeted. */
  meter?: number | null;
  /** The quietest line, under everything: a secondary or qualified answer that
   *  must never compete with the value. First to be dropped in a short box. */
  footer?: ReactNode;
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
  upper = false,
  dim = false,
  align,
  uniform = false,
  captionEnd,
  subEnd,
  meter = null,
  footer = null,
}: ReadoutProps) {
  const side = align ?? DEFAULT_READOUT_ALIGN;
  // One value drives BOTH the flex cross-axis and text-align. The lines are
  // different widths, so aligning the boxes without aligning the text leaves a
  // centred caption sitting over a left-set value.
  const items = side === "right" ? "flex-end" : side === "center" ? "center" : "flex-start";
  const [ref, boxH, boxW] = useBoxSize();
  // Lines are dropped rather than clipped when the box cannot hold them — see
  // fitComposition. A caption cut in half is not a caption.
  const { captionPx, valuePx, subPx, meterPx, footerPx } = fitComposition(
    boxH,
    !!caption,
    !!sub,
    uniform,
    { meter: meter != null, footer: !!footer },
  );
  const { wrapRef, elRef, scale } = useShrinkToWidth([value, valuePx, mono]);

  const filled = !!fill;
  const captionStyle: CSSProperties = {
    fontSize: `${captionPx}px`,
    fontWeight: 600,
    letterSpacing: "0.09em",
    textTransform: "uppercase",
    // Its own face, never the value's: a caption is words, and the mono a
    // numeric readout uses makes words worse.
    //
    // The theme's token, not a literal white. Inside .kiosk-surface — every
    // display, and Home's widget grid — it already resolves to white, so a
    // display looks the same; on a themed page it is legible instead of being
    // white on white. The filled variant keeps literals: its ground is a
    // saturated colour, so white is right in either theme.
    color: filled ? "rgba(255,255,255,0.85)" : "var(--color-fg-muted)",
    lineHeight: CAPTION_LEADING,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 0,
    width: "100%",
    textAlign: side,
  };
  const subStyle: CSSProperties = {
    fontSize: `${subPx}px`,
    color: filled ? "rgba(255,255,255,0.80)" : "var(--color-fg-subtle)",
    lineHeight: SUB_LEADING,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flexShrink: 0,
    width: "100%",
    textAlign: side,
  };

  return (
    <div
      ref={ref}
      style={{
        // The WHOLE object box, over the object's own padding — see PAD_SCALE.
        // Absolute against the object wrapper, which is the nearest positioned
        // ancestor at every nesting depth.
        //
        // THAT IS A REQUIREMENT ON THE HOST, not something this box can check.
        // Three of them draw an object: the canvas wrapper and the editor's are
        // `position: absolute`, and Home's card frame is `relative` — see
        // cardFrame in app/home/home-grid.tsx, which was static, so on Home this
        // box resolved against the grid CELL and every filled ground painted
        // over the card's own border. A fourth host has to position its box too.
        position: "absolute",
        inset: 0,
        padding: `${boxH * PAD_SCALE}px ${Math.min(boxH, boxW) * PAD_SCALE}px`,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        // The object's own vertical alignment where it set one — published as a
        // custom property by boxStyle, because this composition covers the box
        // that would otherwise carry it. Centre is the default and the fallback.
        justifyContent: "var(--readout-v-align, center)",
        alignItems: items,
        gap: `${boxH * GAP_SCALE}px`,
        overflow: "hidden",
        minHeight: 0,
        // NOT `opacity` here. Dimming the whole composition took the CAPTION
        // with it, so a row of widgets had two caption strengths: the dimmed
        // ones at 45% of the muted token, and the ones in an active state — an
        // ERROR, a recording — at full. "REAPER" beside "REAPER" in two
        // different greys, which is what was reported.
        //
        // A caption NAMES the box; it does not report anything, so it reads the
        // same whatever the box is doing. Dim belongs to the reading, and moves
        // to the value and its sub-line below.
        borderRadius: "inherit",
      }}
    >
      {/* The filled ground.
          Absolute against THIS box, whose own padding it therefore covers —
          which is the point: the composition above is itself inset:0 against the
          object wrapper, so the two together reach the object's edge. A ground
          that stops at the content box leaves the object's own background
          drawing a ring around it — the exact bug the recording fill was
          rewritten to avoid. */}
      {filled ? (
        <span
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, background: fill!, borderRadius: "inherit" }}
        />
      ) : null}
      {caption && captionPx > 0 ? (
        /* One row, two ends. `width: 100%` is already on captionStyle, so the row
           spans the box and the end slot sits against the far edge whatever the
           caption's own alignment is — the caption names the box, the end slot
           reports it, and they belong at opposite ends. */
        <span style={{ ...captionStyle, position: "relative", ...(captionEnd != null ? ROW : null) }}>
          <span style={ELLIPSIS}>{caption}</span>
          {captionEnd != null ? <span style={END_SLOT}>{captionEnd}</span> : null}
        </span>
      ) : null}
      <div ref={wrapRef} style={{ width: "100%", minHeight: 0, overflow: "hidden", position: "relative", textAlign: side }}>
        <span
          ref={elRef}
          style={{
            display: "inline-block",
            fontSize: `${valuePx * scale}px`,
            fontWeight: filled ? 700 : 600,
            // Explicit, never inherited: an inherited colour resolved to black
            // on black on the kiosk surface once — measured at 1.06:1. The
            // custom property is the object's OWN colour where it set one (see
            // boxStyle), and falls back to the token where it did not, so this
            // stays explicit either way.
            color: filled ? "#ffffff" : valueColor ?? "var(--readout-value-color, var(--color-fg))",
            // The dim lives here now: it is the READING that is stale or
            // unreachable, not the label naming the box.
            opacity: dim ? 0.45 : 1,
            lineHeight: VALUE_LEADING,
            whiteSpace: "nowrap",
            ...(upper ? { textTransform: "uppercase" as const } : null),
            ...(mono ? { fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" } : null),
          }}
        >
          {value}
        </span>
      </div>
      {sub && subPx > 0 ? (
        <span
          style={{ ...subStyle, position: "relative", opacity: dim ? 0.45 : 1, ...(subEnd != null ? ROW : null) }}
          title={sub}
        >
          <span style={ELLIPSIS}>{sub}</span>
          {subEnd != null ? (
            /* The number the sub-line names. Mono and tabular whatever the value
               is set in: it ticks once a second, and proportional digits are
               different widths, so the text would physically move every tick —
               the one thing a wall readout must not do. */
            <span
              style={{
                ...END_SLOT,
                fontFamily: "var(--font-mono)",
                fontVariantNumeric: "tabular-nums",
                fontWeight: 600,
                color: filled ? "#ffffff" : "var(--readout-value-color, var(--color-fg))",
              }}
            >
              {subEnd}
            </span>
          ) : null}
        </span>
      ) : null}
      {meter != null && meterPx > 0 ? (
        <span
          data-readout-meter
          aria-hidden="true"
          style={{
            position: "relative",
            width: "100%",
            height: `${meterPx}px`,
            borderRadius: `${meterPx}px`,
            overflow: "hidden",
            flexShrink: 0,
            // The TRACK is derived from the same ink as the bar, not from a
            // neutral token. A widget on a stage canvas sets its own colour and
            // is not inside .kiosk-surface, so --color-fg-faint resolved to the
            // LIGHT theme's #b8bec6 there — a pale grey track under a white bar
            // on a black card, measured in the editor. color-mix keeps the two
            // in the same family whatever ink the object is using.
            background: filled
              ? "rgba(255,255,255,0.25)"
              : "color-mix(in srgb, var(--readout-value-color, var(--color-fg)) 22%, transparent)",
            opacity: dim ? 0.45 : 1,
          }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              borderRadius: "inherit",
              // Clamped here as well as at the source: a fraction outside 0..1 —
              // a stale anchor on a display that was asleep — would otherwise
              // draw a bar wider than its own track.
              width: `${Math.min(100, Math.max(0, meter * 100))}%`,
              background: filled ? "#ffffff" : "var(--readout-value-color, var(--color-fg))",
            }}
          />
        </span>
      ) : null}
      {footer && footerPx > 0 ? (
        <span
          style={{
            ...subStyle,
            fontSize: `${footerPx}px`,
            position: "relative",
            // Quieter than the sub-line, deliberately. This line is a QUALIFIED
            // answer — the next playlist entry is only what plays next while the
            // playlist keeps auto-advancing — and it must never read as
            // confidently as the value above it.
            opacity: dim ? 0.35 : 0.7,
          }}
          title={typeof footer === "string" ? footer : undefined}
        >
          {footer}
        </span>
      ) : null}
    </div>
  );
}
