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
 * The chart's x domain: THIS session's own start to its own finish (or "now"
 * while it is still running) — never derived from spans or plan items at all.
 *
 * Built from `sessionStartedAt`/`finishedAt` (BaptismState's own fields, read
 * by SessionChart) because those name the session's real boundary, immune to
 * whatever else the service's plan or the raw file's other sessions happen to
 * cover. This used to take every span and plan item and widen the domain to
 * whatever ANY of them spanned. Seeded with a realistic service — a
 * countdown 25 minutes before the session, the session itself, then a
 * 38-minute sermon and a closing — and driven for real, a session that
 * actually ran about 25m to 47m read as an 0m–85m axis,
 * with the sermon and closing drawn as one wide "not counted" block and the
 * session's own segments squeezed down to bare numbers. See clipToSession and
 * sessionSpans below for how plan items and spans from elsewhere in the same
 * service are kept off the chart now that this no longer widens for them.
 *
 * `live` decides how the open end behaves: LIVE, the domain reaches at least
 * `nowMs` — an armed session with no baptism span yet still needs an axis to
 * draw the gap on. NOT live, the domain stops at `finishedAt` — a session left
 * running across a crash must not be drawn as if it were still happening
 * minutes, or days, later once it does finish. Returns null only when there
 * is no session at all (`sessionStartedAt` null or unparseable) — in
 * practice SessionChart never reaches this with such a state, since a null
 * `sessionStartedAt` also means a null `serviceKey` (see idleState), which
 * shows its own "no session" empty note first; handled here anyway so this
 * function stays correct on its own terms, not merely correct for its one
 * caller today.
 */
export function sessionWindow(
  sessionStartedAt: string | null,
  finishedAt: string | null,
  opts: { live: boolean; nowMs: number },
): { startMs: number; endMs: number } | null {
  const startMs = sessionStartedAt ? Date.parse(sessionStartedAt) : NaN;
  if (!Number.isFinite(startMs)) return null;
  if (opts.live) return { startMs, endMs: Math.max(startMs + 1, opts.nowMs) };
  const finishMs = finishedAt ? Date.parse(finishedAt) : NaN;
  // Not live with no readable finish — a shape this function's one caller
  // never actually produces — draws as a single instant rather than reaching
  // for "now": that is the one thing "not live" must never do.
  return { startMs, endMs: Math.max(startMs + 1, Number.isFinite(finishMs) ? finishMs : startMs) };
}

/**
 * `items`, clipped to `[startMs, endMs]`, with anything entirely outside it
 * dropped — the other half of sessionWindow's own fix. The domain no longer
 * widens for a plan item outside the session, but left
 * unclipped such an item would still measure its own length against the
 * window's edge and could still be mistaken, by anything reading its
 * startedAt/endedAt later, for something that happened during the session.
 *
 * `laneSegments` already clips PIXELS to the plot and hides anything with no
 * overlap at all, so the visible result is the same either way — this exists
 * so that guarantee is this file's own, asserted as arithmetic, rather than a
 * side effect of a shared geometry function every History chart also uses.
 *
 * A boundary touching exactly at either edge is kept, not dropped — matching
 * laneSegments' own inclusive `e >= domainStartMs && s <= domainEndMs`, so
 * the two never disagree about the same instant.
 *
 * An item with an unreadable timestamp is left alone rather than dropped:
 * planLaneItems already excludes anything with no startedAt at all, so
 * anything still unparseable here is a shape neither function anticipated,
 * and drawing it — laneSegments' own `if (!Number.isFinite(s)) continue`
 * already skips it safely — is better than silently discarding a plan item
 * that, in fact, happened.
 */
export function clipToSession(items: readonly LaneItem[], startMs: number, endMs: number): LaneItem[] {
  const out: LaneItem[] = [];
  for (const it of items) {
    const s = Date.parse(it.startedAt);
    const e = it.endedAt === null ? endMs : Date.parse(it.endedAt);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      out.push(it);
      continue;
    }
    if (e < startMs || s > endMs) continue; // no overlap with the session at all
    out.push({
      ...it,
      startedAt: new Date(Math.max(s, startMs)).toISOString(),
      endedAt: new Date(Math.min(e, endMs)).toISOString(),
    });
  }
  return out;
}

/**
 * Only the spans that belong to THIS session, by real time — never every
 * span the service's raw file happens to hold.
 *
 * GET /api/baptism/lane replays the WHOLE service's baptism.csv and returns
 * every session's spans concatenated (baptism-lane.ts's own header: a
 * finished session's spans are pushed to the output when the NEXT session's
 * `start` row is read) — right for a future whole-service view, wrong for a
 * chart whose axis is one session — the same reason sessionWindow's own
 * domain no longer reaches across the rest of the service.
 *
 * Selected by START time landing in `[startMs, endMs]`, never by identity: a
 * span carries no session id of its own, but sessions never overlap in real
 * time (one clock runs at a time — see baptism-lane.ts's own header), so a
 * span starting inside this session's own window cannot belong to any other
 * session, finished or still live.
 */
export function sessionSpans(
  spans: readonly BaptismSpan[],
  startMs: number,
  endMs: number,
): BaptismSpan[] {
  return spans.filter((s) => {
    const at = Date.parse(s.startedAt);
    return Number.isFinite(at) && at >= startMs && at <= endMs;
  });
}

/**
 * Elapsed-minute tick offsets from the session's own start ("0m", "1m", ...),
 * matching the approved design: a 1-minute step up to an 8-minute session, 2
 * minutes up to 20, 5 beyond. That design does not cover a session past an
 * hour; this widens to 10 minutes there, so an hour-plus session does not
 * draw a tick every 5 minutes (36+ of them) — said here rather than left
 * silent, since it is this file's own addition, not the approved design's.
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
