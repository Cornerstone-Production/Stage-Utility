// pvp-countdown-only.tsx — the "Countdown only" layout of the ProVideoPlayer
// "now" widget: the time left, and nothing else.
//
// It does not go through Readout. Readout is a composition (caption, value,
// sub-line, rule) that sizes its value from what the OTHER lines leave over;
// this layout has no other lines, and the whole point of it is that the number
// takes the box. Sizing is the one thing it needs, and the measured box is the
// one thing it asks for: `useBoxSize` is Readout's own, so a resize reaches it
// through the same ResizeObserver.
//
// WHAT NO UNIT TEST CAN SEE: the fit. jsdom loads no layout engine, so the
// measured box is 0 x 0 and the arithmetic (countdownFontPx, tested) answers 0.
// That the number really is as tall as 62% of the box, never wider than it, and
// follows a resize, was driven in a browser — see the PR description. What a
// test CAN reach, and pvp-now.test.tsx does, is what this layout draws and what
// it leaves out.

import { useBoxSize } from "./readout";
import { MeterFill } from "./readout-meter";
import { METER_MIN_PX, METER_SCALE } from "./readout-size";
import { countdownFontPx } from "./pvp-now-config";

/** What stands in for a time when nothing is counting. A dash, dimmed, so a
 *  widget with nothing to count never reads as one that has frozen. */
export const COUNTDOWN_NONE = "—";

export function PvpCountdownOnly({
  time,
  color = null,
  meter = null,
  meterKey = null,
}: {
  /** The formatted time left, or null when nothing is counting. */
  time: string | null;
  /** The warning colour, once the time is inside a threshold. Null is the
   *  ordinary ink. Colours the hairline too. */
  color?: string | null;
  /** 0..1 for the hairline along the bottom edge, or null for none. */
  meter?: number | null;
  /** Which clip `meter` measures — see MeterFill. */
  meterKey?: string | null;
}) {
  const [ref, boxH, boxW] = useBoxSize();
  const text = time ?? COUNTDOWN_NONE;
  const ink = color ?? "var(--readout-value-color, var(--color-fg))";
  const ruleH = Math.max(METER_MIN_PX, boxH * METER_SCALE);
  return (
    <div
      ref={ref}
      data-pvp-countdown-only
      style={{
        // The WHOLE object box, like Readout's: absolute against the object
        // wrapper, over its own padding.
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
        borderRadius: "inherit",
        boxSizing: "border-box",
      }}
    >
      <span
        data-pvp-countdown-value
        style={{
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: 1,
          whiteSpace: "nowrap",
          fontSize: `${countdownFontPx(boxW, boxH, text.length)}px`,
          color: time == null ? "var(--readout-value-color, var(--color-fg))" : ink,
          opacity: time == null ? 0.45 : 1,
        }}
      >
        {text}
      </span>
      {meter != null ? (
        <span
          data-readout-meter
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: `${ruleH}px`,
            overflow: "hidden",
            background: `color-mix(in srgb, ${ink} 22%, transparent)`,
          }}
        >
          <MeterFill fraction={meter} seriesKey={meterKey} fill={ink} />
        </span>
      ) : null}
    </div>
  );
}
