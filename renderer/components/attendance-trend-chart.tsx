// The attendance trend chart.
//
// Extracted from service-history-section.tsx so Home's widget and the History
// tab draw the SAME chart rather than two that drift. "The same style as the
// attendance tab" is only true if it is literally the same component — a second
// implementation is a promise to keep them matching, and this repo has enough
// evidence about how those go.

import { useEffect, useRef, useState } from "react";

import { clamp } from "@main/services/clamp";
import { shortDay, type TrendPoint } from "../settings/sections/overview-data";

/** Real attendance trend chart (SVG): a baseline, the per-service polyline, the
 *  latest point marked, and first/last date labels. The hero of the blend — not
 *  decorative. Falls back to a quiet note when there isn't enough to plot. */
export function AttendanceTrendChart({ points }: { points: TrendPoint[] }) {
  /**
   * The viewBox is the chart's REAL pixel width, measured.
   *
   * It used to be a fixed 640 stretched to fit with `preserveAspectRatio="none"`,
   * which is fine for the polyline — it has a non-scaling stroke — and wrong for
   * everything else in the drawing. On History, where the chart is about 640
   * wide, the scale was near 1 and nobody noticed. On Home's widest tile it is
   * three times that: the date labels came out three times too wide, and the dot
   * marking the latest service was an ellipse.
   *
   * Measuring instead of stretching means one user unit is one pixel, so a
   * circle is a circle at any width, and the same component keeps drawing the
   * same chart on both pages — which is why it is one component.
   */
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  /**
   * And the HEIGHT, because a trend needs an aspect to be a shape.
   *
   * History caps the chart at 640px wide, where 130 tall is a reasonable band.
   * Home hands it a whole XL tile — some 1900px — and at a fixed height that is
   * fifteen to one: the line came out as a nearly flat wire pulled across the
   * card, with the tile's remaining height empty underneath it. Taking the
   * height it is actually given gives the curve room to be a curve.
   *
   * 130 is the floor and the fallback, so History — whose container is
   * auto-height — draws exactly what it always drew.
   */
  const [H, setH] = useState(130);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      // Floors, so a card mid-mount at zero size cannot divide by nothing.
      setW(Math.max(240, Math.round(entry.contentRect.width)));
      setH(Math.max(130, Math.round(entry.contentRect.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const padTop = 16;
  const padBottom = 26;
  const padX = 10;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) {
    return (
      <div className="flex h-full min-h-[130px] items-center justify-center text-caption1 text-fg-subtle">
        Not enough services yet to chart a trend.
      </div>
    );
  }
  // The FULL width of whatever it is given.
  //
  // It was capped at 8:1 for a while, centred, so a wide tile did not render
  // every weekend as the same near-horizontal wire. Asked for outright: a chart
  // in a widget should fill the widget. The aspect is the tile's to decide — a
  // Tall one gives the curve its shape back — and a chart that stops short of
  // its own card reads as broken in a way a shallow slope does not.
  const plotW = W;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const x = (i: number) => padX + (i / (points.length - 1)) * (plotW - padX * 2);
  const y = (v: number) => padTop + (1 - (v - min) / range) * (H - padTop - padBottom);
  const poly = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const lastX = x(points.length - 1);
  const lastY = y(points[points.length - 1].value);
  const latest = points[points.length - 1].value;
  const hp = hover != null ? points[hover] : null;
  const hx = hover != null ? x(hover) : 0;
  const hy = hp ? y(hp.value) : 0;
  return (
    <div className="relative h-full min-h-[130px]" ref={box}>
      <div className="relative h-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${plotW} ${H}`}
        width="100%"
        height={H}
        style={{ display: "block" }}
        // The viewBox matches the measured width, so this scales nothing. It
        // stays "none" only to keep a frame mid-resize — where the measurement
        // is one tick stale — stretched rather than letterboxed, which is the
        // less visible of the two.
        preserveAspectRatio="none"
        onPointerMove={(e) => {
          const svg = svgRef.current;
          if (!svg) return;
          const r = svg.getBoundingClientRect();
          const frac = (e.clientX - r.left) / r.width; // 0..1 across the plotted width
          setHover(clamp(Math.round(frac * (points.length - 1)), 0, points.length - 1));
        }}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Attendance trend across recent services"
      >
        <line x1={0} y1={H - padBottom} x2={plotW} y2={H - padBottom} stroke="var(--su-line)" />
        <polyline points={poly} fill="none" stroke="var(--su-accent)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {/* The newest point is hollow while its service is still recording — that
            total is a partial and will keep climbing, so it must not read as a
            settled weekend. */}
        {points[points.length - 1].live ? (
          <circle cx={lastX} cy={lastY} r={4} fill="var(--su-bg)" stroke="var(--su-accent)" strokeWidth={2} />
        ) : (
          <circle cx={lastX} cy={lastY} r={4} fill="var(--su-accent)" />
        )}
        {hp && (
          <g pointerEvents="none">
            <line x1={hx} y1={padTop} x2={hx} y2={H - padBottom} stroke="var(--su-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={hx} cy={hy} r={4} fill="var(--su-accent)" stroke="var(--su-bg)" strokeWidth={1.5} />
          </g>
        )}
        <text x={padX} y={H - 8} fontFamily="var(--font-mono)" fontSize={11} fill="var(--su-fg-subtle)">{shortDay(points[0].day)}</text>
        <text x={plotW - padX} y={H - 8} textAnchor="end" fontFamily="var(--font-mono)" fontSize={11} fill="var(--su-fg-subtle)">{shortDay(points[points.length - 1].day)}</text>
      </svg>
      {/* Hover tooltip — HTML overlay positioned by % so its text isn't stretched
          by the chart's non-uniform (preserveAspectRatio="none") X scale. */}
      {hp && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line-strong bg-popover px-2 py-1 shadow-md backdrop-blur-xl"
          style={{ left: `${(hx / plotW) * 100}%`, top: `${Math.max(hy - 8, 4)}px` }}
        >
          <div className="font-mono text-caption2 tabular-nums text-fg-subtle whitespace-nowrap">
            {shortDay(hp.day)}{hp.live ? " · recording" : ""}
          </div>
          <div className="font-mono text-caption1 font-medium tabular-nums text-fg text-center">{hp.value.toLocaleString()}</div>
          {hp.parts && hp.parts.length > 1 && (
            <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-1">
              {hp.parts.map((p, i) => (
                <div key={i} className="flex items-center justify-between gap-3 font-mono text-caption2 tabular-nums text-fg-muted whitespace-nowrap">
                  <span>{p.label}</span>
                  <span>{p.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Latest attendance, pinned above the most recent point (hidden while
          hovering so it doesn't collide with the tooltip). Only this one value —
          labeling every point would clutter. */}
      {!hp && (
        <span
          className="pointer-events-none absolute right-1 font-mono text-caption1 font-medium tabular-nums text-fg"
          style={{ top: `${Math.max(0, lastY - 20)}px` }}
        >
          {latest.toLocaleString()}
        </span>
      )}
      </div>
    </div>
  );
}

