// geometry.ts — the arithmetic behind HistoryChart, with no React and no DOM.
//
// Kept separate from the component so the parts that can be WRONG — the y axis,
// the ten-minute x domain, where a gap in sampling breaks the line — are tested
// as arithmetic rather than through a render that jsdom cannot lay out.

/** One sampled point. `t` is epoch ms so nothing re-parses an ISO string per frame. */
export interface ChartPoint {
  t: number;
  v: number;
}

/** A drawn line. `role` picks the weight (1.8px primary / 1.2px secondary). */
export interface ChartSeries {
  id: string;
  label: string;
  /** Any CSS colour — always a theme token at the call sites. */
  color: string;
  points: ChartPoint[];
  role: "primary" | "secondary";
  /** Dashed where a secondary series shares the primary's scale. */
  dashed?: boolean;
  /** Gradient fill from the line down to the axis floor. Primary only. */
  fill?: boolean;
  /** How a value reads in the stat strip and on hover. */
  format?: (v: number) => string;
}

/** What the y axis counts. `db` never floors at zero — 0 dB is not a floor a
 *  sound chart has, and filling to it draws a 60 dB-tall block under every line. */
export type YScale = { kind: "count" } | { kind: "db" };

/** A y axis, resolved: the drawn range and the ticks on it. */
export interface Axis {
  lo: number;
  hi: number;
  ticks: number[];
}

/** 1·2·5×10ⁿ step at or above `target` — the same ladder the people graph and
 *  the old attendance chart use, so the two read consistently (0/500/1000, not
 *  0/531/1062). */
function niceStep(target: number): number {
  const x = target > 1 ? target : 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, Math.round(m * pow));
}

/**
 * The y axis for a set of values.
 *
 * Counts run 0 → a round top with headroom. Decibels run from a multiple of 5
 * below the quietest reading to one above the loudest, because the interesting
 * band of a service is ~20 dB wide and anchoring at zero flattens it to nothing.
 */
export function niceAxis(values: number[], scale: YScale): Axis {
  const finite = values.filter((v) => Number.isFinite(v));
  if (scale.kind === "db") {
    if (!finite.length) return { lo: 60, hi: 100, ticks: [60, 80, 100] };
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const lo = Math.floor((min - 3) / 5) * 5;
    const hi = Math.max(lo + 10, Math.ceil((max + 3) / 5) * 5);
    return { lo, hi, ticks: [lo, Math.round((lo + hi) / 2), hi] };
  }
  const dataMax = Math.max(1, ...finite);
  let step = niceStep(dataMax / 2);
  let hi = 2 * step;
  while (hi <= dataMax) {
    step = niceStep(step + 1);
    hi = 2 * step;
  }
  return { lo: 0, hi, ticks: [0, step, hi] };
}

export const TEN_MINUTES_MS = 10 * 60_000;

/**
 * Where the x axis ends.
 *
 * While a service records, the newest sample is the right edge, and re-scaling
 * on every 30-second sample slides the whole curve leftward once a minute for
 * an hour. Instead the domain ends at a whole ten minutes past the start and
 * only ever steps — six times an hour, not 120.
 */
export function tenMinuteDomainEnd(startMs: number, lastMs: number): number {
  const span = Math.max(0, lastMs - startMs);
  const steps = Math.max(1, Math.ceil(span / TEN_MINUTES_MS));
  return startMs + steps * TEN_MINUTES_MS;
}

/**
 * Break a series wherever sampling stopped.
 *
 * Samples land every 30s, so a run of missing ones means the counter was
 * unreachable or the server was down — not that the room emptied smoothly.
 * Joining across it draws a confident straight line through an hour nobody
 * measured, which is worse than showing nothing there.
 */
export function splitRuns(points: ChartPoint[], gapMs: number): ChartPoint[][] {
  const runs: ChartPoint[][] = [];
  for (const p of points) {
    const cur = runs[runs.length - 1];
    const prev = cur?.[cur.length - 1];
    if (!cur || (prev && p.t - prev.t > gapMs)) runs.push([p]);
    else cur.push(p);
  }
  return runs;
}

export type Project = (p: ChartPoint) => { x: number; y: number };

/** `d` for a polyline through `points`. A single point still draws (a zero-length
 *  line to itself) so the first sample of a live service is visible. */
export function linePathD(points: ChartPoint[], project: Project): string {
  if (!points.length) return "";
  const at = (p: ChartPoint) => {
    const q = project(p);
    return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
  };
  if (points.length === 1) return `M${at(points[0])}L${at(points[0])}`;
  return `M${at(points[0])}${points.slice(1).map((p) => `L${at(p)}`).join("")}`;
}

/** `d` for the gradient fill under a run — dropped to the axis floor at ITS OWN
 *  ends rather than the chart's, so a sampling gap reads as absent, not as zero. */
export function areaPathD(points: ChartPoint[], project: Project, baseY: number): string {
  if (points.length < 2) return "";
  const first = project(points[0]);
  const last = project(points[points.length - 1]);
  return `M${first.x.toFixed(1)},${baseY.toFixed(1)}`
    + points.map((p) => {
      const q = project(p);
      return `L${q.x.toFixed(1)},${q.y.toFixed(1)}`;
    }).join("")
    + `L${last.x.toFixed(1)},${baseY.toFixed(1)}Z`;
}

/** Index of the point nearest `t`, or -1 for an empty series. */
export function nearestIndex(points: ChartPoint[], t: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].t - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
