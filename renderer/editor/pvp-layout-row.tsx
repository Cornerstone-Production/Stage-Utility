// pvp-layout-row.tsx — the Layout choice on a ProVideoPlayer "now" widget: Full,
// Compact or Countdown only, each drawn as a small thumbnail of what it keeps.
//
// A row of three picture buttons rather than the inspector's usual Segmented
// toggle, because the three layouts differ in HOW MUCH they draw, and a picture
// of three bars against two against one number says that faster than the words.
// The hint under the row follows the choice, so the operator reads what the one
// they picked does without opening anything.

import { cn } from "../lib/cn";
import { PVP_NOW_LAYOUT_OPTIONS } from "../main/pvp-now-config";
import type { PvpNowLayout } from "@main/types/views";

/** The bars of each thumbnail: [width %, height px, bright]. The same drawings
 *  the approved mockup used. */
const BARS: Record<PvpNowLayout, [number, number, boolean][]> = {
  full: [[60, 3, false], [40, 6, false], [70, 3, false]],
  compact: [[55, 3, false], [45, 7, false]],
  countdown: [[62, 12, true]],
};

function Thumb({ layout }: { layout: PvpNowLayout }) {
  return (
    <span
      aria-hidden="true"
      // The widget's own dark card, in both themes: the thumbnail pictures a
      // widget on a stage, not a control in the inspector.
      className="flex h-8 w-full max-w-16 flex-col items-center justify-center gap-[3px] rounded-[5px] p-1"
      style={{ background: "#161616" }}
    >
      {BARS[layout].map(([w, h, bright], i) => (
        <i
          key={i}
          className="block rounded-sm"
          style={{ width: `${w}%`, height: h, background: bright ? "rgba(255,255,255,.75)" : "rgba(255,255,255,.45)" }}
        />
      ))}
    </span>
  );
}

export function PvpLayoutRow({ value, onChange }: { value: PvpNowLayout; onChange: (v: PvpNowLayout) => void }) {
  const chosen = PVP_NOW_LAYOUT_OPTIONS.find((o) => o.value === value) ?? PVP_NOW_LAYOUT_OPTIONS[0];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption2 text-fg-muted">Layout</span>
      <div role="group" aria-label="Layout" className="grid grid-cols-3 gap-1.5">
        {PVP_NOW_LAYOUT_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-lg border bg-field px-1.5 pb-1.5 pt-2 text-caption2 leading-tight transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              value === o.value
                ? "border-accent text-fg shadow-[inset_0_0_0_1px_var(--color-accent)]"
                : "border-line-strong text-fg-muted hover:text-fg",
            )}
          >
            <Thumb layout={o.value} />
            <span className="text-center">{o.label}</span>
          </button>
        ))}
      </div>
      <span className="text-caption2 text-fg-subtle">{chosen.hint}</span>
    </div>
  );
}
