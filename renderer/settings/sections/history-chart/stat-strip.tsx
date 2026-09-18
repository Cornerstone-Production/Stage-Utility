// stat-strip.tsx — the row above the plot, and the section's header.
//
// It replaces three things at once: the floating tooltip that followed the
// cursor, the grid of summary tiles above the chart, and the "what is happening
// right now" line a live service had nowhere to put. One row, three states.

import { cn } from "../../../lib/cn";

/** A figure the strip can show. `value` is already formatted — the strip never
 *  decides how a number reads, because dB, counts and durations all differ. */
export interface StatFigure {
  key: string;
  label: string;
  value: string;
  /** A theme colour for the value. Defaults to the foreground. */
  color?: string;
}

/** One series' value at the hovered (or live) instant. */
export interface StripValue {
  label: string;
  value: string;
  color?: string;
}

/** The plan item under the cursor, as the strip says it. */
export interface StripItem {
  number: number;
  title: string;
  ran: string;
  planned: string;
}

export interface StatStripProps {
  /** At rest: the figures the operator chose in Customize. */
  figures: StatFigure[];
  /** Non-null while the pointer is over the plot or the lane. Wins over `live`. */
  hover: { time: string; values: StripValue[]; item: StripItem | null } | null;
  /** Non-null while the record is still open. */
  live: { time: string; values: StripValue[] } | null;
  /** The Customize trigger, pinned to the right end. */
  right?: React.ReactNode;
}

/** 20px mono value over an 11px uppercase label, with a hairline before every
 *  figure but the first. */
function Figure({ label, value, color, first }: { label: string; value: string; color?: string; first: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 px-3 first:pl-0",
        !first && "border-l border-line",
      )}
    >
      <span className="text-caption2 uppercase tracking-wider text-fg-subtle whitespace-nowrap">{label}</span>
      <span
        className="font-mono text-[20px] leading-[24px] font-medium tabular-nums truncate"
        style={{ color: color ?? "var(--color-fg)" }}
      >
        {value}
      </span>
    </div>
  );
}

export function StatStrip({ figures, hover, live, right }: StatStripProps) {
  // Hover wins over live: the operator moved the pointer there to ask about that
  // instant, and a strip that kept answering "now" while the cursor sat on 9:42
  // answered a question nobody asked.
  const mode: "hover" | "live" | "rest" = hover ? "hover" : live ? "live" : "rest";
  const shown: StatFigure[] =
    mode === "hover" && hover
      ? [
        { key: "__time", label: "Time", value: hover.time },
        ...hover.values.map((v, i) => ({ key: `v${i}`, label: v.label, value: v.value, color: v.color })),
        ...(hover.item
          ? [
            { key: "__item", label: `Item ${hover.item.number}`, value: hover.item.title },
            { key: "__ran", label: "Ran", value: hover.item.ran },
            { key: "__planned", label: "Planned", value: hover.item.planned },
          ]
          : []),
      ]
      : mode === "live" && live
        ? [
          { key: "__live", label: "Live", value: live.time, color: "var(--color-live-11)" },
          ...live.values.map((v, i) => ({ key: `l${i}`, label: v.label, value: v.value, color: v.color })),
        ]
        : figures;

  return (
    <div
      className="flex items-end gap-0 overflow-x-auto"
      data-history-strip={mode}
      // The strip is the section's live summary: a pointer move must be
      // announced, or a screen reader hears only the at-rest figures forever.
      role="status"
      aria-live="polite"
    >
      {shown.map((f, i) => (
        <Figure key={f.key} label={f.label} value={f.value} color={f.color} first={i === 0} />
      ))}
      {right && <div className="ml-auto shrink-0 self-center pl-3">{right}</div>}
    </div>
  );
}
