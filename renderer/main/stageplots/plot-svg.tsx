// plot-svg.tsx — one stage plot, drawn. The same component draws a plot in the
// editor, on /stageplots, in a venue card's thumbnail, and (later) in print and
// on the published page, so none of them can drift from the others.
//
// The canvas is PLOT_UNITS_WIDE (1000) units wide; its height follows the
// background's aspect ratio, or 16:9 with a plain grid when there is none.
// Items are drawn in those units, in the empty layer below.

import type { Ref } from "react";

import type { PanZoom } from "./use-pan-zoom";

import { clamp } from "@main/services/clamp";
import { plotHeight } from "@main/services/stageplots-doc";
import { PLOT_UNITS_WIDE, type BackgroundView, type Plot } from "@main/types/stageplots";

import { cn } from "../../lib/cn";

/** Columns in the grid a plot with no background is drawn on. */
const GRID_COLUMNS = 24;

export { plotHeight } from "@main/services/stageplots-doc";

/** How opaque the background is drawn at a fade from 0 (as converted) to 1 (faintest). */
export function backgroundOpacity(fade: number): number {
  return Math.round((1 - clamp(fade, 0, 1) * 0.85) * 1000) / 1000;
}

function PlotGrid({ height }: { height: number }) {
  const step = PLOT_UNITS_WIDE / GRID_COLUMNS;
  const lines: string[] = [];
  for (let x = step; x < PLOT_UNITS_WIDE - 0.5; x += step) lines.push(`M${x.toFixed(2)} 0V${height.toFixed(2)}`);
  for (let y = step; y < height - 0.5; y += step) lines.push(`M0 ${y.toFixed(2)}H${PLOT_UNITS_WIDE}`);
  return (
    <path
      data-testid="plot-grid"
      d={lines.join("")}
      fill="none"
      stroke="var(--su-plot-grid)"
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
    />
  );
}

export interface PlotSvgProps {
  plot: Pick<Plot, "name" | "items">;
  background: BackgroundView | null;
  /** The background fade, 0 to 1. Separate from the plot so a slider can preview it. */
  fade: number;
  /** What part of the plot to show, in plot units; the whole plot when absent. */
  viewBox?: string;
  className?: string;
  svgRef?: Ref<SVGSVGElement>;
  /** Thumbnails are decoration beside a name that says the same. */
  decorative?: boolean;
  /** Pointer handlers from usePanZoom, for a plot that can be zoomed and panned. */
  gestures?: PanZoom["handlers"];
}

export function PlotSvg({ plot, background, fade, viewBox, className, svgRef, decorative, gestures }: PlotSvgProps) {
  const height = plotHeight(background);
  return (
    <svg
      ref={svgRef}
      viewBox={viewBox ?? `0 0 ${PLOT_UNITS_WIDE} ${height}`}
      className={cn("block select-none bg-[var(--su-plot-paper)]", className)}
      style={{ aspectRatio: `${PLOT_UNITS_WIDE} / ${height}` }}
      {...gestures}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": `Stage plot ${plot.name}` })}
    >
      <rect width={PLOT_UNITS_WIDE} height={height} fill="var(--su-plot-paper)" />
      {background ? (
        <image
          data-testid="plot-background"
          href={background.url}
          width={PLOT_UNITS_WIDE}
          height={height}
          opacity={backgroundOpacity(fade)}
          preserveAspectRatio="none"
        />
      ) : (
        <PlotGrid height={height} />
      )}
      {/* The items layer. PR 2 draws a plot's items here. */}
      <g data-items="" />
    </svg>
  );
}
