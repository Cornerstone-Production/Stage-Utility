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

/** A drawn line. `role` picks the weight (1.8px primary / 1.2px secondary)
 *  unless `width` overrides it. */
export interface ChartSeries {
  id: string;
  label: string;
  /** Any CSS colour — always a theme token at the call sites. */
  color: string;
  points: ChartPoint[];
  role: "primary" | "secondary";
  /** Dashed where a secondary series shares the primary's scale. */
  dashed?: boolean;
  /**
   * False = listed in the legend, not drawn on the plot. Default true.
   *
   * The series array is the section's WHOLE offering, not just what is on, so
   * the legend can turn one back on. Filtering before the chart would leave the
   * legend unable to name a series the operator had switched off, which is the
   * one thing a toggle has to be able to do.
   */
  on?: boolean;
  /** Gradient fill from the line down to the axis floor. Primary only. */
  fill?: boolean;
  /**
   * How long a hole in this series means "unmeasured", in ms.
   *
   * The default breaks the line across a sampling gap, which is right for a
   * sampled series and WRONG for anything else. A reference line is two points
   * two hours apart and broke into two dots at the ends of the plot; a step line
   * holding one level across a 25-minute item broke in the middle of the item.
   * Both pass `Infinity`: they have no sampling to have a gap in.
   */
  gapMs?: number;
  /**
   * Explicit runs, when a gap rule cannot express where the line should break.
   *
   * The per-item sound fallback is the case: consecutive items ABUT, so no gap
   * rule separates them, and the line has to break between them anyway — one
   * item's level is not a slope into the next one's. `points` stays the whole
   * series, because hover reads the nearest sample from it.
   */
  runs?: ChartPoint[][];
  /**
   * Stroke width in px, overriding the one `role` picks.
   *
   * For a chart whose lines are PEERS. The trend chart draws one line per
   * service type and none of them is the subject: drawing the busiest at 1.8
   * and the rest at 1.2 said the 9:45 service was the thing being measured and
   * the others were reference lines against it, which is not what it is.
   */
  width?: number;
  /** How a value reads in the stat strip and on hover. */
  format?: (v: number) => string;
  /**
   * The LAST point is still moving, and the segment into it is not finished.
   *
   * Drawn dashed with its node marked, so a glance reads "not done yet" rather
   * than "collapsed" — a Sunday whose evening service is half over is genuinely
   * a smaller number than last Sunday, and a solid line into it says the wrong
   * thing about why.
   *
   * Distinct from `dashed`, which dashes the WHOLE series to separate two lines
   * sharing one scale. A series can be both.
   */
  provisional?: boolean;
}

/** What the y axis counts. `db` never floors at zero — 0 dB is not a floor a
 *  sound chart has, and filling to it draws a 60 dB-tall block under every line. */
export type YScale =
  /**
   * A count.
   *
   * `banded` scales to the DATA — a round step below the quietest reading to a
   * round step above the loudest — instead of running from zero. For the trend
   * chart, where three service types between 900 and 1,600 drew as three lines
   * in the top fifth of a 0–2,000 plot and a hundred-person week looked like
   * nothing. It never bands BELOW zero, and it collapses to zero when the data
   * genuinely reaches down there, because a count's floor is real.
   *
   * The default is still zero-anchored, which is right for a single service's
   * attendance: the curve starts at an empty room and the gradient fills to a
   * floor that means something.
   */
  | { kind: "count"; banded?: boolean }
  | { kind: "db" };

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
    // The SPAN is a multiple of ten, not just the ends, so the middle tick is a
    // multiple of five. 65–100 put "83" between them, which reads as a data
    // value rather than as a gridline.
    const rough = Math.max(lo + 10, Math.ceil((max + 3) / 5) * 5);
    const hi = lo + Math.ceil((rough - lo) / 10) * 10;
    return { lo, hi, ticks: [lo, (lo + hi) / 2, hi] };
  }
  if (scale.banded && finite.length) return bandedCountAxis(finite);
  const dataMax = Math.max(1, ...finite);
  let step = niceStep(dataMax / 2);
  let hi = 2 * step;
  while (hi <= dataMax) {
    step = niceStep(step + 1);
    hi = 2 * step;
  }
  return { lo: 0, hi, ticks: [0, step, hi] };
}

/**
 * Every step the banded axis will consider, as mantissas over the decades.
 *
 * The 1·2·5 ladder the rest of this file uses, plus 2.5 and 4. Both earn their
 * place: without 4 there is no step that frames 800–1,600 in two intervals —
 * the mockup's own numbers, and the shape a church with three service types
 * actually has — and the axis falls back to 500 and a band from 500 to 2,000.
 */
const BAND_MANTISSAS = [1, 2, 2.5, 4, 5] as const;

/** How many intervals a banded axis may have. Two is the fewest that puts a
 *  gridline between the ends; six is the most before the plot is more rule
 *  than line. */
const BAND_MIN_INTERVALS = 2;
const BAND_MAX_INTERVALS = 6;

/**
 * A count axis framed on the data.
 *
 * Every step on the ladder that lands an acceptable number of intervals across
 * the rounded data range is a candidate, and the TIGHTEST band wins: highest
 * floor, then lowest ceiling, then the fewest gridlines. Tightest, because the
 * whole point is that three service types between 900 and 1,600 say nothing
 * drawn on a 0–2,000 axis — they are three flat lines in the top fifth of it,
 * and a hundred-person week is invisible.
 *
 * Never below zero, and it takes zero happily when the data reaches down there:
 * a count's floor is real, unlike a decibel's. A spread too wide for any step
 * to both frame it and clear zero gets zero rather than a wall of gridlines.
 *
 * Fractional steps are refused. These are counts of people; an axis labelled
 * 2.5 / 5 / 7.5 is measuring something else. A fractional MANTISSA is fine once
 * it is multiplied up — 2.5 × 100 is 250, which is a perfectly good step.
 */
function bandedCountAxis(finite: number[]): Axis {
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  // A flat series has no range to frame. Give it one, so the line sits in the
  // middle of the plot rather than along an edge — the same reason the
  // sparkline draws a flat series down the middle.
  const span = max - min || Math.max(1, Math.abs(max) * 0.2);
  // A flat series is SEARCHED as if it spanned that much, so the rounding below
  // has something to round outwards to. Rounding a single value gives lo === hi
  // for every step that divides it, which is no axis at all.
  const flat = max === min;
  const from = flat ? min - span / 2 : min;
  const to = flat ? max + span / 2 : max;
  const base = Math.pow(10, Math.floor(Math.log10(Math.max(span, 1) / BAND_MAX_INTERVALS)));
  const candidates: Axis[] = [];
  for (const decade of [base / 10, base, base * 10, base * 100]) {
    for (const m of BAND_MANTISSAS) {
      const step = m * decade;
      if (step <= 0 || !Number.isInteger(step)) continue;
      const lo = Math.max(0, Math.floor(from / step) * step);
      const hi = Math.ceil(to / step) * step;
      const intervals = Math.round((hi - lo) / step);
      if (intervals < BAND_MIN_INTERVALS || intervals > BAND_MAX_INTERVALS) continue;
      candidates.push({ lo, hi, ticks: Array.from({ length: intervals + 1 }, (_, i) => lo + i * step) });
    }
  }
  if (!candidates.length) {
    const hi = Math.max(1, Math.ceil(max));
    return { lo: 0, hi, ticks: [0, hi / 2, hi] };
  }
  candidates.sort((a, b) =>
    b.lo - a.lo
    || a.hi - b.hi
    // Same band: the fewest gridlines across it.
    || a.ticks.length - b.ticks.length);
  return candidates[0];
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

/** A domain shorter than this gets a tick every ten minutes; longer, every
 *  thirty. One rule, so the axis never carries forty labels or two. */
export const TICK_FINE_DOMAIN_MS = 90 * 60_000;
export const TICK_FINE_MS = 10 * 60_000;
export const TICK_COARSE_MS = 30 * 60_000;

/**
 * Where the time axis is labelled.
 *
 * Anchored to the CLOCK, not to the domain: a service beginning at 19:47 gets
 * 20:00 and 20:30, not 19:47 and 20:17. A chart is read against the time on the
 * wall, and a tick at 20:17 is not a time anybody has in mind.
 *
 * Whole- and half-hour zones land on :00/:30 as intended. The one zone this is
 * approximate in is a :45 offset (Nepal, the Chathams), where a ten-minute tick
 * reads :05/:15/… — still evenly spaced and still legible, just not round.
 */
export function timeTicks(startMs: number, endMs: number): number[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const step = endMs - startMs < TICK_FINE_DOMAIN_MS ? TICK_FINE_MS : TICK_COARSE_MS;
  const out: number[] = [];
  for (let t = Math.ceil(startMs / step) * step; t <= endMs; t += step) out.push(t);
  return out;
}

/**
 * Where a DATE axis is labelled.
 *
 * The Trends chart's domain is weeks or a year, not one service, so the
 * clock-anchored ticks above would produce four hundred of them. Anchored on
 * the week instead: at most ~13 labels across a year, and every tick is a
 * Sunday-to-Saturday boundary an operator can place a service against.
 *
 * The step widens with the domain so the count stays readable: weekly up to
 * ~14 weeks, fortnightly to ~30, then monthly-ish (4 weeks). Local midnight,
 * because a week boundary is a calendar thing and a UTC one lands on Saturday
 * evening in Chicago.
 */
export function dateTicks(startMs: number, endMs: number): number[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const WEEK = 7 * 24 * 60 * 60_000;
  const weeks = (endMs - startMs) / WEEK;
  // The step grows with the span so the tick COUNT stays in the low teens at any
  // range. A 4-week step is right for a season and a smear at three years: 156
  // weeks of it is 39 ticks, a mark every 49px, which reads as hatching rather
  // than as an axis. A quarter, then a half-year, keeps it to a dozen or so
  // however far back the All range reaches.
  const stepWeeks = weeks <= 14 ? 1
    : weeks <= 30 ? 2
      : weeks <= 60 ? 4
        : weeks <= 200 ? 13
          : 26;
  const out: number[] = [];
  // Start on the first local midnight at or after the domain start, then step
  // in whole days so a daylight-saving shift cannot drift the ticks by an hour.
  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  if (cursor.getTime() < startMs) cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() <= endMs) {
    out.push(cursor.getTime());
    cursor.setDate(cursor.getDate() + stepWeeks * 7);
  }
  return out;
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

/**
 * The `t` of the nearest drawn node across every given series, or null when
 * none of them has a point.
 *
 * For a chart whose x axis counts DAYS. The pointer lands between nodes, and a
 * readout built off its raw position names a calendar day nothing was recorded
 * on — "Feb 3" beside Feb 1's figure, on a Tuesday. Snapped, the crosshair, the
 * date and the figures are one statement about one real day.
 *
 * Across every series rather than the first, so the day it lands on is the
 * nearest RECORDED one whichever type recorded it.
 */
export function nearestNodeT(series: { points: ChartPoint[] }[], t: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const s of series) {
    const i = nearestIndex(s.points, t);
    if (i < 0) continue;
    const d = Math.abs(s.points[i].t - t);
    if (d < bestD) {
      bestD = d;
      best = s.points[i].t;
    }
  }
  return best;
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
