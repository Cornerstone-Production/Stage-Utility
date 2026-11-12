// plot-legend.tsx — a plot's legend: one row per label and colour, with a
// glyph for what it is and "×2" when there are two, then the callout key. The
// editor's legend panel, /stageplots and print draw it with this.

import type { ReactNode } from "react";

import type { PlotItem } from "@main/types/stageplots";

import { cn } from "../../lib/cn";
import { eyebrow } from "./doc-helpers";
import { calloutKey, legendRows, type LegendRow } from "./legend";
import { Mono } from "./mono";
import { Part, SYMBOLS } from "./symbols";

/** A row's glyph, 24 x 16: what the group of items looks like, in its colour. */
export function LegendGlyph({ row }: { row: Pick<LegendRow, "type" | "color" | "symbol" | "dashed"> }) {
  const col = row.color ?? "currentColor";
  let g: ReactNode;
  if (row.type === "cable") g = <path d="M2 8H22" strokeWidth={2.2} strokeDasharray={row.dashed ? "4 3" : undefined} fill="none" style={{ stroke: col }} />;
  else if (row.type === "conn")
    g = (
      <>
        <rect x={6} y={2} width={12} height={12} rx={3} style={{ fill: col }} />
        {/* The plot's paper, as the connection point on the plot draws its socket: the
            panel's own colour is translucent in dark theme and the socket vanished. */}
        <circle cx={12} cy={8} r={3} data-socket="" style={{ fill: "var(--su-plot-paper)" }} />
      </>
    );
  else if (row.type === "zone")
    g = <rect x={2} y={2} width={20} height={12} rx={3} strokeWidth={1.3} strokeDasharray="3 2" style={{ fill: col, fillOpacity: 0.18, stroke: col }} />;
  else if (row.type === "box") g = <rect x={3} y={2} width={18} height={12} rx={2} strokeWidth={1.4} style={{ fill: col, fillOpacity: 0.1, stroke: col }} />;
  else if (row.type === "circle") g = <ellipse cx={12} cy={8} rx={9} ry={6} strokeWidth={1.4} style={{ fill: col, fillOpacity: 0.1, stroke: col }} />;
  else
    g = (
      <g transform="translate(4 0) scale(.16)" fill="none" stroke="currentColor" strokeWidth={9} strokeLinejoin="round" strokeLinecap="round" style={{ color: col }}>
        {row.symbol && SYMBOLS[row.symbol].parts.map((p, i) => <Part key={i} part={p} />)}
      </g>
    );
  return (
    <svg viewBox="0 0 24 16" aria-hidden className="h-4 w-6 flex-none text-[var(--legend-ink,var(--su-fg-muted))]">
      {g}
    </svg>
  );
}

const rowClass = "inline-flex items-center gap-[7px] text-caption1 text-fg-soft";

export interface PlotLegendProps {
  items: readonly PlotItem[];
  /** "wrap" lays rows across (a panel); "column" one under another (print). */
  layout?: "wrap" | "column";
  /** Shown when there is nothing to list; nothing is rendered without one. */
  emptyHint?: string;
  className?: string;
  /** More sections after the callout key: print's connection points. */
  children?: ReactNode;
}

export function PlotLegend({ items, layout = "wrap", emptyHint, className, children }: PlotLegendProps) {
  const rows = legendRows(items);
  const callouts = calloutKey(items);
  if (rows.length === 0 && callouts.length === 0 && !children && !emptyHint) return null;
  const list = layout === "wrap" ? "flex flex-wrap gap-x-[18px] gap-y-1.5" : "flex flex-col gap-[5px]";
  return (
    <div className={cn("flex flex-col gap-2", className)} aria-label="Legend" role="group" data-testid="legend">
      <span className={eyebrow}>Legend</span>
      {rows.length === 0 && callouts.length === 0 && emptyHint ? (
        <p className="text-caption1 text-fg-subtle">{emptyHint}</p>
      ) : (
        <div className={list}>
          {rows.map((r) => (
            <span key={`${r.label}|${r.color ?? ""}`} className={cn(rowClass, layout === "wrap" && "whitespace-nowrap")} data-testid="legend-row">
              <LegendGlyph row={r} />
              <span>
                <Mono text={r.label} />
              </span>
              {r.count > 1 && <span className="font-mono text-[11px] text-fg-subtle tabular-nums">×{r.count}</span>}
            </span>
          ))}
        </div>
      )}
      {callouts.length > 0 && (
        <>
          <span className={eyebrow}>Callouts</span>
          <div className={list}>
            {callouts.map((c) => (
              <span key={c.n} className={rowClass} data-testid="callout-key">
                <span className="inline-grid size-[18px] flex-none place-items-center rounded-full bg-[var(--legend-ink,var(--su-fg-muted))] font-mono text-[10px] font-semibold text-[var(--legend-on,var(--su-bg))]">
                  {c.n}
                </span>
                <span>
                  <Mono text={c.text} />
                </span>
              </span>
            ))}
          </div>
        </>
      )}
      {children}
    </div>
  );
}
