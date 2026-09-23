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
    const e = endedAt === null ? opts.nowMs : Date.parse(endedAt);
    if (Number.isFinite(e)) ends.push(e);
  };
  for (const s of spans) take(s.startedAt, s.endedAt);
  for (const it of items) take(it.startedAt, it.endedAt);
  if (!starts.length) return null;
  const startMs = Math.min(...starts);
  const rawEnd = Math.max(...ends);
  const endMs = opts.live ? Math.max(opts.nowMs, rawEnd) : rawEnd;
  // A domain of zero width (a single instantaneous mark) divides by zero
  // downstream in laneSegments' own scale — never actually zero in practice
  // (a span always has duration once it has an end, and a running one is
  // bounded by nowMs > its own start), but guarded rather than assumed.
  return { startMs, endMs: Math.max(startMs + 1, endMs) };
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
    { key: "hoverStart", label: "Started", value: formatClock(item.startedAt) },
    {
      key: "hoverEnd",
      label: item.endedAt === null ? "Still running" : "Ended",
      value: item.endedAt === null ? "—" : formatClock(item.endedAt),
    },
  ];
}
