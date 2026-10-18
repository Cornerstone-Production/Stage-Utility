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
// The fit itself is browser-only (jsdom measures every box as 0 x 0); the
// arithmetic is countdownFontPx, tested, and pvp-countdown-layout.test.tsx says
// what was driven in a browser.

import { DEFAULT_READOUT_ALIGN } from "@main/types/readout-types";
import type { LayoutHAlign } from "@main/types/views";

import { readoutAlignItems, useBoxSize } from "./readout";
import { MeterFill } from "./readout-meter";
import { meterHeightPx } from "./readout-size";
import { countdownFontPx } from "./pvp-now-config";

/** What stands in for a time when nothing is counting. A dash, dimmed, so a
 *  widget with nothing to count never reads as one that has frozen. */
const COUNTDOWN_NONE = "—";

export function PvpCountdownOnly({
  time,
  color = null,
  meter = null,
  meterKey = null,
  align = null,
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
  /** The object's horizontal alignment, from its Align pad. The vertical one
   *  arrives the way Readout's does, as the `--readout-v-align` custom property
   *  the object's box publishes. Unset is Readout's own default, so the pad shows
   *  what is drawn. */
  align?: LayoutHAlign | null;
}) {
  const [ref, boxH, boxW] = useBoxSize();
  const text = time ?? COUNTDOWN_NONE;
  const ink = color ?? "var(--readout-value-color, var(--color-fg))";
  const ruleH = meterHeightPx(boxH);
  return (
    <div
      ref={ref}
      data-pvp-countdown-only
      style={{
        // The WHOLE object box, like Readout's: absolute against the object
        // wrapper, over its own padding.
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "var(--readout-v-align, center)",
        alignItems: readoutAlignItems(align ?? DEFAULT_READOUT_ALIGN),
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
