// history-chart.tsx — one chart for every History surface.
//
// Attendance and Sound are two configurations of this component, and the trends
// chart on All services will be a third. What it draws:
//
//   stat strip        the section header — at rest, on hover, or LIVE
//   plot              one line per series, no plot-area fill, hatched outside
//                     the service window
//   item lane         two rows of plan-item blocks on the same x scale
//
// Everything is theme tokens; there is no colour literal in this file. Type is
// IBM Plex Sans for prose and Plex Mono for every number and axis label.
//
// WHAT IS NOT UNIT-TESTED HERE, AND WHY. jsdom lays nothing out: every element
// reports offsetWidth 0, getBoundingClientRect() is all zeros, and no stylesheet
// is loaded, so a test cannot see a hatch on the wrong rect, a label that
// overflows its block, or a 20px value that came out 13px. Those were checked in
// a headless browser against a real record (see the PR). The tests below cover
// what is arithmetic (geometry.ts, lane.ts) and what is structural (which
// elements exist, that the path element survives a live append).

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "../../../lib/cn";
import { prefersReducedMotion } from "../../../lib/reduced-motion";
import { formatClock } from "../../../lib/clock-format";
import { fmtDur } from "../overview-data";
import {
  areaPathD,
  linePathD,
  nearestIndex,
  niceAxis,
  splitRuns,
  tenMinuteDomainEnd,
  timeTicks,
  type ChartPoint,
  type ChartSeries,
  type YScale,
} from "./geometry";
import { laneLabel, laneSegments, segmentAt, type LaneItem, type LaneSegment } from "./lane";
import { makeTextMeasurer } from "./measure-text";
import { StatStrip, type StatFigure } from "./stat-strip";

/** Sampling gap past which the line breaks rather than spanning the silence. */
const GAP_MS = 3 * 60_000;

/** The width below which the lane keeps only its in-service row and labels drop
 *  to rundown numbers. Tailwind's `sm` is 640; this is the chart's own floor,
 *  named in the spec, and it is about how much room a BLOCK has, not the page. */
const NARROW_PX = 600;

const LANE_FONT = "500 11px \"IBM Plex Mono\", ui-monospace, monospace";

export interface HistoryChartProps {
  /** Drawn back to front; the primary series draws last and on top. */
  series: ChartSeries[];
  items: LaneItem[];
  /** The service proper. Outside it the plot is hatched. */
  window: { startedAt: string | null; endedAt: string | null };
  yScale: YScale;
  /** At-rest figures, already formatted, in the operator's chosen order. */
  figures: StatFigure[];
  /** True while the record is still open. Turns on the live edge and the strip's
   *  LIVE state, and makes the current item's block grow. */
  live?: boolean;
  /** The Customize trigger. Rendered at the strip's right end. */
  customize?: React.ReactNode;
  /** Names the plot for a screen reader. */
  ariaLabel: string;
  /** What to say when there is nothing to draw. The default assumes a service
   *  that has not recorded yet; a caller whose emptiness has another cause —
   *  no metric chosen — says so instead of letting the wrong sentence stand. */
  emptyNote?: string;
  /** Makes the legend a toggle. Wire it to the SAME handler Customize uses, so
   *  the two controls over one choice cannot disagree. */
  onToggleSeries?: (id: string) => void;
  /** Test seam: the wall clock the live edge and a live item's block run to. */
  nowMs?: number;
}

const PAD_L = 44;
const PAD_R = 14;
const PAD_T = 12;
const PLOT_H = 150;
const AXIS_H = 16;
const LANE_ROW_H = 16;
const LANE_GAP = 3;

export function HistoryChart({
  series,
  items,
  window: serviceWindow,
  yScale,
  figures,
  live = false,
  customize,
  ariaLabel,
  emptyNote,
  onToggleSeries,
  nowMs,
}: HistoryChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [hoverRow, setHoverRow] = useState<"plot" | "pre" | "service" | null>(null);

  // 1 unit = 1 px: the SVG's viewBox tracks the measured container width rather
  // than a fixed 600, so a measured label width in CSS px can be compared
  // directly against a segment's width in plot units. With a fixed viewBox the
  // two differ by the scale factor and the label rule silently drifts with the
  // window size.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      // jsdom reports 0 for every box; keep the default rather than collapsing
      // the chart to nothing.
      if (w > 0) setWidth(Math.max(320, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = width < NARROW_PX;
  const reduced = prefersReducedMotion();

  const W = width;
  const plotX0 = PAD_L;
  const plotX1 = W - PAD_R;
  const plotY0 = PAD_T;
  const plotY1 = PAD_T + PLOT_H;
  const laneY0 = plotY1 + AXIS_H;

  /** What is actually drawn. `series` is the whole offering — see ChartSeries.on. */
  const shown = useMemo(() => series.filter((s) => s.on !== false), [series]);
  const all = useMemo(() => shown.flatMap((s) => s.points), [shown]);
  const axis = useMemo(() => niceAxis(all.map((p) => p.v), yScale), [all, yScale]);

  const firstT = all.length ? Math.min(...all.map((p) => p.t)) : NaN;
  const lastT = all.length ? Math.max(...all.map((p) => p.t)) : NaN;
  const now = useWallClock(live, nowMs);
  // A live record's right edge is the clock, not the newest sample: a service
  // whose counter has been quiet for two minutes should show two minutes of
  // empty axis, not stop time.
  const rightT = live ? Math.max(lastT, now) : lastT;
  const targetEnd = Number.isFinite(firstT) ? (live ? tenMinuteDomainEnd(firstT, rightT) : rightT) : NaN;
  const domainEnd = useEasedValue(targetEnd, live && !reduced ? 600 : 0);
  const domainStart = firstT;
  const span = domainEnd - domainStart || 1;

  const xOf = (t: number) => plotX0 + ((t - domainStart) / span) * (plotX1 - plotX0);
  const yOf = (v: number) => plotY1 - ((v - axis.lo) / (axis.hi - axis.lo || 1)) * PLOT_H;
  const project = (p: ChartPoint) => ({ x: xOf(p.t), y: yOf(p.v) });

  const measure = useMemo(() => makeTextMeasurer(LANE_FONT), []);
  const axisTicks = useMemo(() => timeTicks(domainStart, domainEnd), [domainStart, domainEnd]);
  const segments = useMemo(
    () =>
      Number.isFinite(domainStart)
        ? laneSegments(items, {
          domainStartMs: domainStart,
          domainEndMs: domainEnd,
          liveEdgeMs: live ? Math.min(now, domainEnd) : domainEnd,
          plotX0,
          plotX1,
        })
        : [],
    [items, domainStart, domainEnd, live, now, plotX0, plotX1],
  );

  /**
   * Where each row starts, once overlapping items have been stacked.
   *
   * The PRE row's extra lanes push the service row down. Without that they
   * collide: a pre item in lane 1 and an in-service item in lane 0 both land on
   * line 1 and draw on top of each other — which is the exact invisibility the
   * stacking was added to fix, moved one row over. Seen on the 17 Sep record,
   * where "10 min Warning" (pre, lane 1) sat underneath "VIDEO: Pre-roll".
   */
  const lastLaneIn = (row: "pre" | "service") =>
    segments.reduce((m, seg) => (seg.row === row ? Math.max(m, seg.lane) : m), -1);
  const preLines = narrow ? 0 : lastLaneIn("pre") + 1;
  // The service row keeps its line even when no pre item was recorded, so the
  // lane sits where it does on every other service.
  const serviceLine = narrow ? 0 : Math.max(1, preLines);
  const laneLines = serviceLine + Math.max(1, lastLaneIn("service") + 1);
  const H = laneY0 + laneLines * LANE_ROW_H + (laneLines - 1) * LANE_GAP + 4;

  // The service window's hatch bands.
  const wStart = serviceWindow.startedAt ? Date.parse(serviceWindow.startedAt) : NaN;
  const wEnd = serviceWindow.endedAt ? Date.parse(serviceWindow.endedAt) : NaN;
  const clampX = (x: number) => Math.min(plotX1, Math.max(plotX0, x));
  const bandX0 = Number.isFinite(wStart) ? clampX(xOf(wStart)) : null;
  const bandX1 = Number.isFinite(wEnd) ? clampX(xOf(wEnd)) : null;
  const hasPre = bandX0 != null && bandX0 > plotX0 + 1;
  const hasPost = bandX1 != null && bandX1 < plotX1 - 1;

  // ── Hover ──
  const hoverT = hoverX != null && Number.isFinite(domainStart)
    ? domainStart + ((hoverX - plotX0) / (plotX1 - plotX0)) * span
    : null;
  const hoveredSegment: LaneSegment | null =
    hoverX != null && hoverRow && hoverRow !== "plot" ? segmentAt(segments, hoverX, hoverRow) : null;
  const hoverValues = hoverT == null
    ? []
    : shown.flatMap((s) => {
      const i = nearestIndex(s.points, hoverT);
      if (i < 0) return [];
      return [{ label: s.label, value: fmt(s, s.points[i].v), color: s.color }];
    });
  const hoverStrip = hoverT == null
    ? null
    : {
      time: formatClock(new Date(hoverT).toISOString()),
      values: hoverValues,
      item: hoveredSegment
        ? {
          number: hoveredSegment.item.sequence + 1,
          title: hoveredSegment.item.title || "Untitled",
          ran: fmtDur(hoveredSegment.item.actualSec),
          planned: fmtDur(hoveredSegment.item.plannedSec),
          peak: hoveredSegment.item.peakLabel ?? null,
        }
        : null,
    };
  const liveStrip = live && all.length
    ? {
      time: formatClock(new Date(lastT).toISOString()),
      values: shown.flatMap((s) => {
        const last = s.points[s.points.length - 1];
        return last ? [{ label: s.label, value: fmt(s, last.v), color: s.color }] : [];
      }),
    }
    : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (r.width === 0) return;
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    if (x < plotX0 || x > plotX1) {
      setHoverX(null);
      setHoverRow(null);
      return;
    }
    setHoverX(x);
    setHoverRow(
      y <= plotY1 ? "plot"
      : !narrow && y < laneY0 + LANE_ROW_H ? "pre"
      : "service",
    );
  }

  if (!all.length) {
    return (
      // THE REF GOES ON BOTH BRANCHES.
      //
      // The width effect runs once, on mount, and returns early when the host
      // is not there. This branch used to render without the ref, so a section
      // whose data arrives AFTER the first paint — the sound chart, which fetches
      // its series — mounted empty, the observer was never attached, and the
      // chart stayed at its 640px default: a half-width plot letterboxed in the
      // middle of a 1,256px card, for the rest of the page's life.
      <div className="flex flex-col gap-3" ref={hostRef}>
        <StatStrip figures={figures} hover={null} live={null} right={customize} />
        <div className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center text-caption1 text-fg-muted">
          {emptyNote ?? "Nothing recorded yet — the chart fills in as the service runs."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" ref={hostRef}>
      <StatStrip figures={figures} hover={hoverStrip} live={liveStrip} right={customize} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        className="block select-none"
        role="img"
        aria-label={ariaLabel}
        // The drawn x domain, so a test can assert the ten-minute stepping
        // directly. Reading it off the axis LABELS does not work: the last tick
        // is the last half-hour INSIDE the domain, which does not move when the
        // domain does, and a guard over it passes on a chart that tracks every
        // sample.
        data-domain-end={Number.isFinite(domainEnd) ? Math.round(domainEnd) : undefined}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHoverX(null);
          setHoverRow(null);
        }}
      >
        <defs>
          {/* 45° hatch for the time outside the service window. A pattern, not a
              flat tint: a tint reads as "dimmed data", a hatch reads as "not the
              service". */}
          <pattern id={`${uid}-hatch`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1={0} y1={0} x2={0} y2={6} stroke="var(--color-line)" strokeWidth={1} />
          </pattern>
          {shown.filter((s) => s.fill).map((s) => (
            <linearGradient key={s.id} id={`${uid}-fill-${s.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>

        {/* Grid at the y ticks. No plot-area fill — the plot's background is the
            card's, so two charts stacked read as one surface. */}
        {axis.ticks.map((t) => (
          <g key={t}>
            <line
              x1={plotX0}
              y1={yOf(t)}
              x2={plotX1}
              y2={yOf(t)}
              stroke="var(--color-line)"
              strokeWidth={1}
              opacity={0.7}
              vectorEffect="non-scaling-stroke"
            />
            <text x={plotX0 - 8} y={yOf(t) + 4} textAnchor="end" className="fill-fg-subtle font-mono text-[11px] tabular-nums">
              {axisLabel(t, yScale)}
            </text>
          </g>
        ))}

        {hasPre && (
          <rect
            data-hatch="pre"
            x={plotX0}
            y={plotY0}
            width={(bandX0 as number) - plotX0}
            height={PLOT_H}
            fill={`url(#${uid}-hatch)`}
          />
        )}
        {hasPost && (
          <rect
            data-hatch="post"
            x={bandX1 as number}
            y={plotY0}
            width={plotX1 - (bandX1 as number)}
            height={PLOT_H}
            fill={`url(#${uid}-hatch)`}
          />
        )}
        {hasPre && (
          <line x1={bandX0 as number} y1={plotY0} x2={bandX0 as number} y2={plotY1} stroke="var(--color-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
        {hasPost && (
          <line x1={bandX1 as number} y1={plotY0} x2={bandX1 as number} y2={plotY1} stroke="var(--color-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}

        {/* Series. Every path is keyed by series id and run index and NEVER by
            sample count, so appending a sample updates `d` on the element that is
            already there instead of replacing it — see history-chart-live.test.tsx. */}
        {shown.map((s) => {
          const runs = s.runs ?? splitRuns(s.points, s.gapMs ?? GAP_MS);
          return (
            <g key={s.id} data-series={s.id}>
              {s.fill
                && runs.map((run, i) => (
                  <path
                    key={`a${i}`}
                    data-series-area={s.id}
                    d={areaPathD(run, project, plotY1)}
                    fill={`url(#${uid}-fill-${s.id})`}
                  />
                ))}
              {runs.map((run, i) => (
                <path
                  key={`l${i}`}
                  data-series-line={s.id}
                  d={linePathD(run, project)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.role === "primary" ? 1.8 : 1.2}
                  strokeDasharray={s.dashed ? "4 3" : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          );
        })}

        {/* The stretch that just arrived, drawn in over 200ms on top of the line
            it is already part of.
            A SEPARATE element on purpose. Animating the series path itself would
            mean restarting a CSS animation on an element React is deliberately
            keeping — and a keyed remount to force the restart is exactly the
            thing the live guard exists to prevent. This one is keyed by the
            newest sample's timestamp, so it remounts (and replays) per append
            and takes the persistent path with it nowhere. */}
        {live && !reduced && shown.map((s) => {
          const n = s.points.length;
          if (n < 2) return null;
          const tail = s.points.slice(n - 2);
          return (
            <path
              key={`${s.id}-in-${tail[1].t}`}
              data-series-draw-in={s.id}
              d={linePathD(tail, project)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.role === "primary" ? 1.8 : 1.2}
              strokeLinecap="round"
              pathLength={1}
              vectorEffect="non-scaling-stroke"
              className="su-history-draw-in"
            />
          );
        })}

        {/* Live edge: a 4px dot at the newest sample of the primary series. */}
        {live && (() => {
          const primary = shown.find((s) => s.role === "primary") ?? shown[0];
          const last = primary?.points[primary.points.length - 1];
          if (!last) return null;
          return (
            <circle
              data-live-edge=""
              cx={xOf(last.t)}
              cy={yOf(last.v)}
              r={4}
              fill={primary.color}
              className={reduced ? undefined : "su-history-pulse"}
            />
          );
        })()}

        {/* Time axis. Ticks on the clock's own half-hours (ten minutes on a
            short domain), not just the two ends — two labels two hours apart
            say nothing about where in the service a bump happened. A label that
            would hang off either edge is dropped; its tick stays. */}
        {axisTicks.map((t) => {
          const x = xOf(t);
          const label = formatClock(new Date(t).toISOString());
          const halfLabel = measure(label) / 2;
          const fits = x - halfLabel >= plotX0 - 2 && x + halfLabel <= plotX1 + 2;
          return (
            <g key={t} data-axis-tick={t}>
              <line
                x1={x}
                y1={plotY1}
                x2={x}
                y2={plotY1 + 4}
                stroke="var(--color-line-strong)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              {fits && (
                <text
                  x={x}
                  y={plotY1 + 14}
                  textAnchor="middle"
                  data-axis-label={t}
                  className="fill-fg-subtle font-mono text-[11px] tabular-nums"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}
        {/* A domain too short for even one tick still says when it was. */}
        {axisTicks.length === 0 && (
          <text x={plotX0} y={plotY1 + 14} data-axis-label="start" className="fill-fg-subtle font-mono text-[11px] tabular-nums">
            {formatClock(new Date(domainStart).toISOString())}
          </text>
        )}

        {/* Item lane. */}
        {segments.filter((s) => s.visible && (!narrow || s.row === "service")).map((seg, i) => {
          const row = (seg.row === "pre" && !narrow ? 0 : serviceLine) + seg.lane;
          const y = laneY0 + row * (LANE_ROW_H + LANE_GAP);
          const w = Math.max(0, seg.x1 - seg.x0);
          const label = narrow
            ? numberOnly(seg, w, measure)
            : laneLabel(seg.item, w, measure);
          const hovered = hoveredSegment?.item.itemId === seg.item.itemId
            && hoveredSegment?.item.sequence === seg.item.sequence;
          const outline = seg.row === "pre";
          return (
            <g key={`${seg.item.itemId}-${seg.item.sequence}-${i}`} data-lane-row={seg.row}>
              <rect
                data-lane-segment={seg.item.itemId}
                x={seg.x0}
                y={y}
                width={w}
                height={LANE_ROW_H}
                rx={3}
                fill={outline ? "transparent" : "var(--color-fill)"}
                stroke={hovered ? "var(--color-accent)" : "var(--color-line-strong)"}
                strokeWidth={hovered ? 1.5 : 1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={outline ? "3 2" : undefined}
              />
              {label.kind !== "none" && (
                <text
                  x={seg.x0 + 6}
                  y={y + 11}
                  data-lane-label={label.kind}
                  className={cn(
                    "text-[11px]",
                    label.kind === "number" ? "font-mono tabular-nums fill-fg-subtle" : "fill-fg-muted",
                  )}
                >
                  {label.text}
                </text>
              )}
              {/* Sound only: this item's loudest reading, marked on its block. */}
              {seg.item.peakLabel && w > 8 && (
                <line
                  data-peak-mark={seg.item.itemId}
                  // The TOP EDGE, not the full height. A full-height tick drew
                  // straight through the item's own label — "Trem|ble",
                  // "What a|God" — which is worse than not marking it at all.
                  x1={(seg.x0 + seg.x1) / 2}
                  y1={y}
                  x2={(seg.x0 + seg.x1) / 2}
                  y2={y + 4}
                  stroke={shown.find((s) => s.role === "primary")?.color ?? "var(--color-accent)"}
                  strokeWidth={3}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          );
        })}

        {/* Crosshair. */}
        {hoverX != null && (
          <line
            data-crosshair=""
            x1={hoverX}
            y1={plotY0}
            x2={hoverX}
            y2={plotY1}
            stroke="var(--color-line-strong)"
            strokeWidth={1}
            pointerEvents="none"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {/* The legend IS the quick toggle. It lists every series the section
          offers, drawn or not, and clicking one is the same action as ticking
          it in Customize — `onToggleSeries` is wired to the same handler, so
          the two can never disagree. Without a handler it is a plain legend. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption2 text-fg-muted">
        {series.map((s) => {
          const on = s.on !== false;
          const swatch = s.dashed
            // The swatch is the LINE: a dashed series gets a dashed rule, not
            // the same filled dot as the solid one beside it. Two identical
            // dots said the two lines were drawn alike when one is a dashed
            // reference.
            ? <span className="inline-block w-3 border-t border-dashed" style={{ borderColor: s.color }} />
            : <span className="size-2.5 rounded-full" style={{ background: s.color }} />;
          if (!onToggleSeries) {
            return (
              <span key={s.id} className="inline-flex items-center gap-1.5">{swatch}{s.label}</span>
            );
          }
          return (
            <button
              key={s.id}
              type="button"
              data-series-toggle={s.id}
              aria-pressed={on}
              onClick={() => onToggleSeries(s.id)}
              className={cn(
                "touch-target inline-flex items-center gap-1.5 rounded px-1 py-0.5",
                "hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus",
                // An off series stays legible — it is a control, not a
                // disabled one — but reads as off at a glance.
                !on && "opacity-45 line-through decoration-1",
              )}
            >
              {swatch}
              {s.label}
            </button>
          );
        })}
        {(hasPre || hasPost) && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-[2px] border border-line-strong"
              style={{ backgroundImage: "repeating-linear-gradient(45deg, var(--color-line) 0 1px, transparent 1px 3px)" }}
            />
            Before / after service
          </span>
        )}
      </div>
    </div>
  );
}

function fmt(s: ChartSeries, v: number): string {
  return s.format ? s.format(v) : Math.round(v).toLocaleString();
}

function axisLabel(v: number, scale: YScale): string {
  return scale.kind === "db" ? String(Math.round(v)) : v.toLocaleString();
}

/** The narrow lane never prints a title — there is no width at which one fits
 *  and still leaves the block readable — but it still measures the number,
 *  because a two-character label in a six-pixel block is no better. */
function numberOnly(seg: LaneSegment, width: number, measure: (t: string) => number) {
  return laneLabel({ ...seg.item, title: "" }, width, measure);
}

/**
 * The wall clock, while a record is open.
 *
 * A live chart's right edge is the CLOCK, not the newest sample: a counter that
 * has been quiet for two minutes should show two minutes of empty axis rather
 * than stopping time, and the live item's block should keep growing through it.
 * That means the component has to re-render without new data, which is what this
 * is for — every 15s, which is half the attendance sampling interval and a
 * quarter of a pixel on an hour-wide plot.
 *
 * Starts at 0 rather than reading the clock during render (a render must be
 * pure, and the lint rule here enforces it). The consequence is one frame on
 * mount where a live chart's edge sits at its newest sample instead of at `now`
 * — which is where it sits for a finished record anyway.
 */
function useWallClock(enabled: boolean, override?: number): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (override != null || !enabled) return;
    // The first read is a task rather than a synchronous setState in the effect
    // body: the latter is a cascading render, and the lint rule here says so.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [enabled, override]);
  return override ?? now;
}

/**
 * Ease toward `target` over `ms`; `ms <= 0` means no motion at all.
 *
 * Used for the x domain, which steps by ten minutes: without this the whole
 * curve jumps left by a sixth of the plot every ten minutes of a live service.
 * `ms <= 0` covers a finished record (nothing is moving) and
 * `prefers-reduced-motion` alike, and in that case there is NO state here — the
 * render uses `target` directly, so nothing is ever left mid-tween.
 */
function useEasedValue(target: number, ms: number): number {
  const [tween, setTween] = useState<number | null>(null);
  const fromRef = useRef(target);

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const from = fromRef.current;
    fromRef.current = target;
    if (ms <= 0 || !Number.isFinite(from) || from === target || typeof requestAnimationFrame !== "function") return;
    const start = Date.now();
    let raf = requestAnimationFrame(function tick() {
      const k = Math.min(1, (Date.now() - start) / ms);
      // easeOutCubic — quick off the step, settling into the new domain.
      const eased = 1 - Math.pow(1 - k, 3);
      setTween(k < 1 ? from + (target - from) * eased : null);
      if (k < 1) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);

  return tween ?? target;
}
