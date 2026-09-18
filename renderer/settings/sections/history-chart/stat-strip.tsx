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
  /** A second, quieter line under the value — "+2:14 late", "3 of 12 over".
   *  The service page's header KPIs carry one; the chart strips do not. */
  sub?: string;
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
  /** Sound only: what this item peaked at, already formatted. The lane marks it
   *  with a tick; the strip is where the NUMBER is read. */
  peak?: string | null;
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
  /**
   * Whether the strip is a polite live region. True for a chart strip, whose
   * whole job is to answer "what is under the cursor" and "what is happening
   * now". FALSE for the service header's KPI row: those change every second
   * while a service records, and a live region there reads six figures aloud
   * on every tick.
   */
  announce?: boolean;
}

/** 20px mono value over an 11px uppercase label, with a hairline before every
 *  figure but the first. */
function Figure({ label, value, color, sub, first }: { label: string; value: string; color?: string; sub?: string; first: boolean }) {
  return (
    <div
      className={cn(
        // `shrink-0`: the row is a scroller, so a narrow window must push
        // figures off the right-hand end, not squash them. Shrinking turned
        // "20:06" into "20…" and "1:07:47" into "1:07…" on a 600px window —
        // a truncated number is worse than one you have to scroll to.
        "flex shrink-0 flex-col gap-0.5 px-3 first:pl-0",
        !first && "border-l border-line",
      )}
    >
      <span className="whitespace-nowrap text-caption2 uppercase tracking-wider text-fg-subtle">{label}</span>
      <span
        // The cap is for hover mode, whose value is a plan item's TITLE: a long
        // one would otherwise push every other figure off the visible end.
        // No number this strip shows comes near it.
        className="max-w-[14rem] truncate font-mono text-[20px] font-medium leading-[24px] tabular-nums"
        style={{ color: color ?? "var(--color-fg)" }}
      >
        {value}
      </span>
      {sub && <span className="max-w-[14rem] truncate whitespace-nowrap text-caption2 text-fg-subtle">{sub}</span>}
    </div>
  );
}

export function StatStrip({ figures, hover, live, right, announce = true }: StatStripProps) {
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
            // Only when the caller has one. The attendance lane never does, and
            // a "Peaked —" column on every hover is noise.
            ...(hover.item.peak ? [{ key: "__peak", label: "Peaked at", value: hover.item.peak }] : []),
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
      // `items-start`, not `items-end`. A chart strip's figures are all the same
      // shape so it made no difference there, but the service header's KPIs
      // carry a second line on some figures and not others, and bottom-aligning
      // dropped "Peak SPL A Fast" a whole line below the five beside it.
      className="flex items-start gap-0 overflow-x-auto"
      data-history-strip={mode}
      // The strip is the section's live summary: a pointer move must be
      // announced, or a screen reader hears only the at-rest figures forever.
      // See `announce` — the service header's KPI row opts out.
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
    >
      {shown.map((f, i) => (
        <Figure key={f.key} label={f.label} value={f.value} color={f.color} sub={f.sub} first={i === 0} />
      ))}
      {right && <div className="ml-auto shrink-0 self-center pl-3">{right}</div>}
    </div>
  );
}
