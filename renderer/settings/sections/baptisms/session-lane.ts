// session-lane.ts — the arithmetic behind the Session chart: turning a
// service's timer spans and plan items into the two lanes it draws, and the
// gaps between them.
//
// Pure, like history-chart/geometry.ts and history-chart/lane.ts, and for the
// same reason: the parts here that have a wrong answer — which stretches count
// as "not counted", whether a still-open span grows to now or stops at the
// window's end — are tested as arithmetic rather than through a render jsdom
// cannot lay out. session-chart.tsx does no math of its own beyond calling
// laneSegments with the LaneItem arrays this file builds.

import type { BaptismSpan } from "@main/services/archive/baptism-lane";

import { fmtClock } from "../../../main/use-baptism-state";
import { formatClock } from "../../../lib/clock-format";
import type { LaneItem, StatFigure } from "../history-chart";

/** A timer span, placed on the lane like a plan item — see LaneItem. Extends
 *  it (rather than replacing the field set) so it can still be handed straight
 *  to laneSegments/laneLabel, which know only LaneItem. `kind` and `person`
 *  ride along on the same object for the renderer and the hover figures to
 *  read back off `LaneSegment.item` after a cast — see session-chart.tsx. */
export interface TimerLaneItem extends LaneItem {
  kind: BaptismSpan["kind"];
  person: number;
}

/**
 * Every span as a LaneItem, in the SAME order they were recorded.
 *
 * The label is "Person N" so laneLabel's existing title/number rule reads
 * naturally either way it lands: the full "Person 3" when the block is wide
 * enough, the bare "3" (sequence + 1) when only that fits. There is no second,
 * genuinely different string to fall back to here — unlike a plan item, a
 * span's whole identity IS the person number — so `sequence` is `person - 1`
 * on purpose, to make the number laneLabel falls back to the right one.
 */
export function timerLaneItems(spans: readonly BaptismSpan[]): TimerLaneItem[] {
  return spans.map((s) => ({
    itemId: `${s.kind}-${s.person}-${s.startedAt}`,
    title: `Person ${s.person}`,
    sequence: s.person - 1,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    preService: false,
    plannedSec: null,
    actualSec: null,
    kind: s.kind,
    person: s.person,
  }));
}

/**
 * Plan items as a LaneItem, dropping every item with no `startedAt` — a plan
 * item PCO never showed live has nothing to place on the axis.
 *
 * `preService` is always false, never the item's own flag. laneSegments splits
 * "pre" and "service" into two INDEPENDENTLY stacked buckets, which is right
 * for History's attendance chart (a real "before the service" concept, drawn
 * hatched) and wrong here: this chart has one plan lane, and forcing every item
 * into the "service" bucket is what keeps that lane's own overlap stacking —
 * the one History already tests — correct for it.
 */
export function planLaneItems(items: readonly ServiceTimelineItem[]): LaneItem[] {
  return items
    .filter((it) => it.startedAt)
    .map((it) => ({
      itemId: it.itemId,
      title: it.title,
      sequence: it.sequence,
      startedAt: it.startedAt,
      endedAt: it.endedAt,
      preService: false,
      plannedSec: it.plannedLengthSec,
      actualSec: it.actualDurationSec,
    }));
}

/**
 * The stretches no span covers: the armed wait for the first person, an
 * explicit pause, the walk from the testimonies to the water — every gap
 * between one span's end and the next span's start, plus, when the LAST span
 * is closed, the stretch from there to `windowEndIso`.
 *
 * `windowEndIso` is what makes the trailing case correct for BOTH a live
 * session (the caller passes "now", so an armed wait with no baptism span yet
 * still reads as a growing gap) and a finished or past one (the caller passes
 * the session's own recorded end, never "now" — see the handoff on stopping an
 * open span at the window's end rather than growing it, in session-chart.tsx).
 *
 * A run with no daylight between spans — including one ending exactly where
 * the next begins — produces nothing: this is a POSITIVE-width test, not a
 * "spans.length - 1" count, so touching spans are silently fine.
 *
 * The still-RUNNING span (endedAt null) is never a gap's start: there is
 * nothing after it to be a gap until it closes, and by construction it can
 * only be the last span in the array.
 */
export function gapSpans(
  spans: readonly BaptismSpan[],
  windowEndIso: string,
): { startedAt: string; endedAt: string }[] {
  if (!spans.length) return [];
  const gaps: { startedAt: string; endedAt: string }[] = [];
  for (let i = 1; i < spans.length; i++) {
    const prevEnd = spans[i - 1]!.endedAt;
    if (prevEnd === null) continue; // only the LAST span may still be open
    const nextStart = spans[i]!.startedAt;
    if (Date.parse(nextStart) > Date.parse(prevEnd)) gaps.push({ startedAt: prevEnd, endedAt: nextStart });
  }
  const last = spans[spans.length - 1]!;
  if (last.endedAt !== null) {
    const windowEndMs = Date.parse(windowEndIso);
    if (Number.isFinite(windowEndMs) && windowEndMs > Date.parse(last.endedAt)) {
      gaps.push({ startedAt: last.endedAt, endedAt: windowEndIso });
    }
  }
  return gaps;
}

/**
 * The chart's x domain: the earliest a span or plan item starts, to the
 * latest either reaches.
 *
 * `live` decides how the open end behaves, and it is the one thing this
 * function cannot get from the arrays alone. LIVE, the domain reaches at least
 * `nowMs` — an armed session with no baptism span yet still needs an axis to
 * draw the gap on. NOT live (a finished session, or later a genuinely past one
 * off History), the domain stops at the recorded ends: a session left running
 * across a crash must not be drawn as if it were still happening minutes, or
 * days, later. Returns null for nothing to draw at all — no spans and no plan
 * items — which is the "no service open" empty state's cue.
 */
export function sessionWindow(
  spans: readonly BaptismSpan[],
  items: readonly LaneItem[],
  opts: { live: boolean; nowMs: number },
): { startMs: number; endMs: number } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  const take = (startedAt: string, endedAt: string | null) => {
    const s = Date.parse(startedAt);
    if (Number.isFinite(s)) starts.push(s);
    // An open span/item's only CERTAIN instant is its own start. "now" is
    // introduced ONLY by the `opts.live` check below, never here — that is
    // the fix for Fix round 1's I1: this used to substitute `opts.nowMs` for
    // any open span regardless of `live`, so a session left running across a
    // crash (baptism-lane.ts's own header documents the shape) read back two
    // days later drew as still growing, two days wide.
    const e = endedAt === null ? s : Date.parse(endedAt);
    if (Number.isFinite(e)) ends.push(e);
  };
  for (const s of spans) take(s.startedAt, s.endedAt);
  for (const it of items) take(it.startedAt, it.endedAt);
  if (!starts.length) return null;
  const startMs = Math.min(...starts);
  const rawEnd = Math.max(...ends);
  const endMs = opts.live ? Math.max(opts.nowMs, rawEnd) : rawEnd;
  // A domain of zero width (a single instantaneous mark) divides by zero
  // downstream in laneSegments' own scale. LIVE it never actually happens
  // (bounded by nowMs > its own start); NOT live it is the ordinary shape
  // for a session whose only span is the one still open when read back — its
  // own start is both `startMs` and its contribution to `ends` — so this
  // floor is load-bearing there, not just a defensive fallback.
  return { startMs, endMs: Math.max(startMs + 1, endMs) };
}

/**
 * Elapsed-minute tick offsets from the session's own start ("0m", "1m", ...),
 * per the approved mockup (mockup-v3.html's own `draw()`, near its `stepMin`
 * line): a 1-minute step up to an 8-minute session, 2 minutes up to 20, 5
 * beyond. The mockup does not cover a session past an hour; this widens to 10
 * minutes there, so an hour-plus session does not draw a tick every 5 minutes
 * (36+ of them) — said here rather than left silent, since it is this file's
 * own addition, not the mockup's.
 *
 * LOCAL to this chart, not a change to `history-chart/geometry.ts`'s
 * `timeTicks()`: every History chart's domain is a whole SERVICE, tens of
 * minutes to a few hours, and its 10-minute floor (for anything under 90
 * minutes) is right for that. A baptism SESSION is commonly much shorter — a
 * single press-to-press segment is often under a minute (see
 * docs/features/scriptview-and-baptisms.md's "Armed, then running") — and
 * `timeTicks`'s own floor draws NO axis at all, zero ticks, for any session
 * under ten minutes. Changing that floor would also change History's own
 * attendance and sound charts, which this fix must not touch.
 *
 * Returns absolute ms timestamps (like `timeTicks`), so `xOf`/`keepAxisLabels`
 * in session-chart.tsx need no change beyond which tick array and which text
 * formatter they are handed.
 */
export function sessionAxisTicks(domainStartMs: number, domainEndMs: number): number[] {
  if (!Number.isFinite(domainStartMs) || !Number.isFinite(domainEndMs) || domainEndMs <= domainStartMs) return [];
  const spanMs = domainEndMs - domainStartMs;
  const stepMs =
    spanMs <= 8 * 60_000
      ? 60_000
      : spanMs <= 20 * 60_000
        ? 2 * 60_000
        : spanMs <= 60 * 60_000
          ? 5 * 60_000
          : 10 * 60_000;
  const out: number[] = [];
  for (let t = domainStartMs; t <= domainEndMs; t += stepMs) out.push(t);
  return out;
}

/** "0m", "1m", ... — minutes elapsed since the session's own start. Never a
 *  clock time: this axis answers "how long has this session run", the same
 *  question the Trends card's "Whole segment" figure answers in words, not
 *  "what time is it" — the one thing every other clock-anchored axis in this
 *  app (History's own charts) is for. */
export function sessionAxisLabel(t: number, domainStartMs: number): string {
  return `${Math.round((t - domainStartMs) / 60_000)}m`;
}

/**
 * What the page's stat strip says while a timer segment is hovered: the
 * person, the phase and its duration, and the boundary times — press to
 * press, the same thing a person's own row in the People card means.
 *
 * `windowEndMs` is the SAME boundary the segment was drawn to — the live edge
 * for a running span, the window's end for one a past service left open — so
 * a hovered bar's reported duration always matches its own drawn length.
 * Never `Date.now()`: a caller mid-render already knows the instant its chart
 * is using and must hand it in, or the two could disagree.
 *
 * `hoverStart`/`hoverEnd` carry seconds (`{ seconds: true }`), unlike every
 * other clock in this app: a baptism segment is commonly under a minute (the
 * mockup's own hover shows seconds for exactly this reason), and without them
 * Started and Ended can read identically — "4:51" and "4:51" — for a span the
 * duration figure right beside them correctly calls "0:03". Still `formatClock`,
 * the same formatter (and so the same time zone handling) every other time in
 * this chart uses; only the option passed to it changes.
 */
export function timerHoverFigures(item: TimerLaneItem, windowEndMs: number): StatFigure[] {
  const start = Date.parse(item.startedAt);
  const end = item.endedAt === null ? windowEndMs : Date.parse(item.endedAt);
  const durMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  const isTestimony = item.kind === "testimony";
  return [
    { key: "hoverPerson", label: "Hovering", value: `Person ${item.person}` },
    {
      key: "hoverPhase",
      label: isTestimony ? "Testimony" : "Baptism",
      value: fmtClock(durMs),
      color: isTestimony ? "var(--color-accent)" : "var(--color-live-11)",
    },
    { key: "hoverStart", label: "Started", value: formatClock(item.startedAt, { seconds: true }) },
    {
      key: "hoverEnd",
      label: item.endedAt === null ? "Still running" : "Ended",
      value: item.endedAt === null ? "—" : formatClock(item.endedAt, { seconds: true }),
    },
  ];
}
