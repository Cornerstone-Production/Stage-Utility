// session-chart.tsx — the Session card: a baptism session drawn as two lanes
// on one time axis, timer over plan, so the planning conversation can answer
// "how much of the song set did the baptisms take" — which no single lane can,
// because the dunks spread across several songs. See "The Session chart" in
// docs/features/scriptview-and-baptisms.md for what an operator sees.
//
// NOT HistoryChart: that component needs a series[] and a yScale, and this
// chart has no y axis — a baptism session is a sequence, not a measurement over
// time. What IS reused is the lane GEOMETRY (laneSegments/laneLabel/segmentAt),
// the text measurer and keepAxisLabels' collision avoidance, so overlap
// stacking, clipping and the live edge behave exactly as History's do. The
// axis TICKS themselves are this chart's own (session-lane.ts's
// sessionAxisTicks): this chart moved off history-chart's timeTicks(), whose
// 10-minute floor drew no axis at all for the sub-ten-minute sessions this
// chart commonly has to draw; see that function's own comment. The SVG itself
// is this file's own.
//
// WHAT IS NOT UNIT-TESTED HERE, AND WHY — same reasoning as history-chart.tsx's
// own note: jsdom loads no stylesheet and lays nothing out, so a test cannot see
// a block positioned a pixel off, a label that overflows its bar, or the
// live-edge pulse actually pulsing. What IS unit-tested: the arithmetic
// (session-lane.ts), the fetch-on-push behaviour (session-chart-refetch.test.tsx,
// which needs a real render but asserts on invoke() call counts, not on pixels),
// the Customize toggle's wiring and persistence (session-chart.test.tsx, which
// needs a real render but asserts on element presence, not pixels), and the
// three empty-state branches rendering the right text (session-chart.test.tsx).
// Checked in a real browser against seeded, real recorded sessions — short and
// long, both workflows.

import { useEffect, useMemo, useRef, useState } from "react";

import type { BaptismSpan } from "@main/services/archive/baptism-lane";
import { errorMessage } from "@main/services/errors";

import { invoke, onNotification } from "../../../lib/api";
import { logToServer } from "../../../lib/client-log";
import { prefersReducedMotion } from "../../../lib/reduced-motion";
import { useServerNow } from "../../../lib/server-clock";
import { useServiceTimeline } from "../../../main/use-service-timeline";
import { toast } from "../../../components/ui";
import { PeopleTable } from "./people-table";
import {
  CustomizePopover,
  keepAxisLabels,
  laneLabel,
  laneSegments,
  segmentAt,
  useStoredKeys,
  type LaneItem,
  type LaneSegment,
  type StatFigure,
} from "../history-chart";
import { LANE_LABEL_PADDING } from "../history-chart/lane";
import { makeTextMeasurer } from "../history-chart/measure-text";
import {
  clipToSession,
  gapSpans,
  planLaneItems,
  sessionAxisLabel,
  sessionAxisTicks,
  sessionSpans,
  sessionWindow,
  timerHoverFigures,
  timerLaneItems,
  type TimerLaneItem,
} from "./session-lane";

/** The Session card's own Customize choice: whether the plan lane draws at
 *  all. One group, one option, deliberately — see the card's own head for
 *  why nothing else belongs in this popover. A per-browser view preference
 *  like every other Customize in this app (see history-chart/prefs.ts), not a
 *  recording setting. */
export const SESSION_LANES_STORAGE_KEY = "baptism:sessionLanes";
export const SESSION_LANE_KEYS = ["planItems"];
export const DEFAULT_SESSION_LANES = ["planItems"];

const LANE_FONT = "500 11px \"IBM Plex Mono\", ui-monospace, monospace";
const PAD_L = 46;
const PAD_R = 14;
const PAD_T = 10;
const ROW_H = 30;
const ROW_GAP = 6;
/** Air between the timer lane group and the plan lane group — the two are
 *  different KINDS of thing on the same axis, not two rows of one lane. */
const LANE_SPACING = 14;
const AXIS_H = 18;

/**
 * The session's timer lane, fetched once and refetched on every LIVE
 * "baptism:state" push — never on a timer, and never twice for one push (a
 * REPLAYED frame is the connect-time cache a late subscriber is handed, which
 * this component's own mount fetch already accounts for; refetching on it too
 * would be a second read of the same truth, not a new one).
 *
 * `error` is its OWN field, never folded into an empty `spans: []` — a fetch
 * that failed (a network blip, a server restart mid-service) is not a session
 * that recorded nothing, and the two used to be indistinguishable on screen.
 * A later push clears it naturally: fetching is already change-driven, so the
 * next successful read replaces it without anything here needing to retry by
 * hand.
 *
 * Exported for session-chart-refetch.test.tsx, which drives this through the
 * real renderer/lib/api.ts with a fake EventSource and proves the fetch count
 * tracks pushes, not elapsed time — the guard a polling implementation fails.
 */
export function useSessionLane(
  serviceKey: string | null,
): { spans: BaptismSpan[]; loaded: boolean; error: boolean } {
  // Keyed by the serviceKey it was fetched FOR, so switching services (or
  // losing one) shows loading/empty rather than the previous session's spans
  // for the one render before the new fetch resolves.
  const [fetched, setFetched] = useState<{ key: string; spans: BaptismSpan[]; error: boolean } | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (!serviceKey) return;
    return onNotification("baptism:state", (_payload, replayed) => {
      if (!replayed) setRev((n) => n + 1);
    });
  }, [serviceKey]);

  useEffect(() => {
    if (!serviceKey) return; // nothing to fetch — the derived return below covers it
    let cancelled = false;
    invoke<{ spans: BaptismSpan[] }>("baptism:lane", { serviceKey })
      .then((res) => {
        if (!cancelled) setFetched({ key: serviceKey, spans: res.spans, error: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Reaches /log — a bare console.warn only ever reached a devtools
        // console nobody has open at 9am on a Sunday. See client-log.ts.
        logToServer("baptism", `session lane fetch failed for ${serviceKey}: ${errorMessage(err)}`);
        setFetched({ key: serviceKey, spans: [], error: true });
      });
    return () => {
      cancelled = true;
    };
    // `rev` is read by nothing above; it exists only to retrigger this fetch
    // on a live "baptism:state" push — see the first effect.
  }, [serviceKey, rev]);

  if (!serviceKey) return { spans: [], loaded: true, error: false };
  if (fetched?.key !== serviceKey) return { spans: [], loaded: false, error: false };
  return { spans: fetched.spans, loaded: true, error: fetched.error };
}

/**
 * The plan lane for a session that is NOT live: fetched once per serviceKey,
 * with nothing to refetch on — a finished session's own recorded timeline does
 * not change under it, unlike the live one (see useServiceTimeline, which
 * refetches on "service-timeline:history" for exactly that reason).
 *
 * A failure here degrades to an empty plan lane rather than its own EMPTY-STATE
 * note: unlike the timer lane, it never produces a WRONG statement on screen —
 * the timer lane still draws; there is simply no plan block under it. It is
 * not silent either way, though: logToServer always reaches /log, and the
 * caller shows its own small note when `error` is true and the plan lane
 * would otherwise just look empty with nothing said about why.
 */
function usePastPlanItems(
  serviceKey: string | null,
  active: boolean,
): { items: ServiceTimelineItem[]; error: boolean } {
  const [fetched, setFetched] = useState<{ key: string; items: ServiceTimelineItem[]; error: boolean } | null>(null);
  useEffect(() => {
    if (!active || !serviceKey) return;
    let cancelled = false;
    invoke<ServiceTimeline | null>("serviceTimeline:get", { serviceKey })
      .then((tl) => {
        if (!cancelled) setFetched({ key: serviceKey, items: tl?.items ?? [], error: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logToServer("baptism", `plan timeline fetch failed for ${serviceKey}: ${errorMessage(err)}`);
        setFetched({ key: serviceKey, items: [], error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [serviceKey, active]);
  if (!active || !serviceKey) return { items: [], error: false };
  if (fetched?.key !== serviceKey) return { items: [], error: false };
  return { items: fetched.items, error: fetched.error };
}

/**
 * One PAST session's own chart, on that session's own window — the stateless
 * half of HistorySessionChart below. Kept separate so several of these can
 * sit under ONE shared width measurement and ONE shared pair of fetches
 * (HistorySessionChart's own), each still owning its own hover position: a
 * pointer over session 1's lane must not highlight a segment in session 2's.
 */
function PastSessionChart({
  width,
  win,
  spans,
  planItems,
  reduced,
  measure,
}: {
  width: number;
  win: { startMs: number; endMs: number };
  spans: BaptismSpan[];
  planItems: LaneItem[];
  reduced: boolean;
  measure: (s: string) => number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (r.width === 0) return;
    setHoverX(((e.clientX - r.left) / r.width) * width);
  }
  return (
    <SessionSvg
      svgRef={svgRef}
      width={width}
      win={win}
      live={false}
      now={win.endMs}
      reduced={reduced}
      measure={measure}
      spans={spans}
      timerItems={timerLaneItems(spans)}
      planItems={planItems}
      showPlanLane
      hoverX={hoverX}
      onMove={onMove}
      onLeave={() => setHoverX(null)}
    />
  );
}

export interface HistorySessionChartProps {
  serviceKey: string;
  /** Every baptism session History linked to this service (linkBaptisms) —
   *  usually one; a reset-and-restart, or two sessions genuinely recorded in
   *  one service, means more, and each gets its own chart-or-note and its
   *  own per-person splits, in the order given. */
  sessions: readonly BaptismSession[];
}

/**
 * The read-only, PAST-service entry point onto the Session chart, for the
 * Baptisms card on a service's History page.
 *
 * Shares useSessionLane and usePastPlanItems outright with the live
 * SessionChart above — one fetch of each, for the WHOLE service, exactly as
 * they already work — and slices per session with the same
 * sessionWindow/sessionSpans/clipToSession arithmetic every live chart uses
 * (see sessionSpans' own comment: the lane endpoint already returns every
 * session's spans concatenated, which is what makes drawing more than one
 * session here possible without a second route). SessionSvg itself is never
 * copied, only called again. Nothing here is imported by
 * baptism-operator.tsx, so the live Baptisms page renders exactly as before.
 *
 * A session matched to this service by exact serviceKey but whose own window
 * has no spans in the shared lane (recorded before the raw layer existed, or
 * the merge otherwise never captured it) — and a session matched only by
 * time overlap, which by construction can never have raw rows filed under
 * THIS service's key — both get their splits and one plain line saying no
 * timeline was recorded, never an empty chart that reads as nothing
 * happened.
 */
export function HistorySessionChart({ serviceKey, sessions }: HistorySessionChartProps) {
  const { spans, loaded, error } = useSessionLane(serviceKey);
  const { items: planItemsAll, error: planError } = usePastPlanItems(serviceKey, true);
  const reduced = prefersReducedMotion();
  const measure = useMemo(() => makeTextMeasurer(LANE_FONT), []);

  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  // THE REF GOES ON CONTENT THAT IS ALWAYS RENDERED — see history-chart.tsx's
  // own "THE REF GOES ON BOTH BRANCHES" note for the identical bug. This
  // effect runs ONCE, on mount, before useSessionLane's fetch — which never
  // resolves synchronously — has any chance to flip `loaded` true. An early
  // `return null` above this div meant the FIRST render had no element for
  // the ref to find at all: the effect fired once against
  // `hostRef.current === null`, attached to nothing, and (deps `[]`) never
  // ran again once the real content finally existed — the chart was stuck at
  // its 640px default for the rest of the page's life, regardless of the
  // card's own real width. The `!loaded` gate now lives INSIDE the div,
  // around the children alone, so this div — and the ref on it — exists from
  // the very first render.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) setWidth(Math.max(320, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const multiple = sessions.length > 1;

  return (
    <div ref={hostRef} className="flex flex-col gap-5">
      {!loaded ? null : sessions.map((session) => {
        // Only a session KEYED to this exact service can have raw rows in
        // its shared lane at all — one matched by time overlap (a keyless,
        // older session) never ran under this key, so there is nothing in
        // these rows that could be its. See linkBaptisms' own doc comment.
        const win = session.serviceKey === serviceKey
          ? sessionWindow(session.startedAt, session.finishedAt, { live: false, nowMs: 0 })
          : null;
        const sessionOnlySpans = win ? sessionSpans(spans, win.startMs, win.endMs) : [];
        const hasChart = !error && win && sessionOnlySpans.length > 0;
        return (
          <div key={session.id} className="flex flex-col gap-3">
            {multiple && (
              <span className="text-caption2 font-medium uppercase tracking-wider text-fg-subtle">
                Session · {new Date(session.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
            {hasChart ? (
              <>
                <PastSessionChart
                  width={width}
                  win={win}
                  spans={sessionOnlySpans}
                  planItems={clipToSession(planLaneItems(planItemsAll), win.startMs, win.endMs)}
                  reduced={reduced}
                  measure={measure}
                />
                <Legend />
              </>
            ) : error ? (
              <ErrorNote text="Couldn't load the timing lane. Reload the page to try again." />
            ) : (
              <EmptyNote text="No timing detail was recorded for this session." />
            )}
            <PeopleTable people={session.people} />
          </div>
        );
      })}
      {/* One plan-fetch note for the whole card, not per session: it is the
          same fetch (usePastPlanItems is keyed on serviceKey alone) and the
          same failure either way. */}
      {planError && (
        <p role="alert" className="text-caption2 text-danger-11">
          Plan items could not be loaded; the log has the details.
        </p>
      )}
    </div>
  );
}

/** The deepest lane index in use, or -1 for no segments — see laneSegments. */
function maxLane(segments: readonly LaneSegment[]): number {
  return segments.reduce((m, s) => Math.max(m, s.lane), -1);
}

export interface SessionChartProps {
  state: BaptismState;
  /**
   * What a hovered timer segment says, so the page's header can show it in
   * the stat strip instead of the at-rest figures — the same swap History's
   * own attendance and sound charts make when hovered. Called with null when
   * nothing is hovered, and once more when this unmounts.
   */
  onHover?: (figures: StatFigure[] | null) => void;
}

export function SessionChart({ state, onHover }: SessionChartProps) {
  const serviceKey = state.serviceKey ?? null;
  // A clock is still reachable — testimony, baptism, armed or paused — even
  // though none of those has an OPEN span at every instant (armed and paused
  // both close their last span; see baptism-lane.ts). "Live" here means the
  // WALL CLOCK keeps moving, which is what decides whether the domain and any
  // trailing gap grow toward now or stop at the recorded window's end.
  const live = state.phase !== "idle";

  const { spans, loaded, error } = useSessionLane(serviceKey);
  const currentTimeline = useServiceTimeline();
  const { items: pastItems, error: planError } = usePastPlanItems(serviceKey, !live);
  // The live timeline can outrun this session (a producer moves on to the next
  // plan the moment the baptisms finish), so it is only this session's plan
  // while its own serviceKey still matches.
  const rawPlanItems: ServiceTimelineItem[] =
    live && currentTimeline?.serviceKey === serviceKey ? currentTimeline.items : !live ? pastItems : [];

  const now = useServerNow(1000, live);
  const reduced = prefersReducedMotion();

  const [laneKeys, toggleLane] = useStoredKeys(SESSION_LANES_STORAGE_KEY, SESSION_LANE_KEYS, DEFAULT_SESSION_LANES);
  const showPlanLane = laneKeys.includes("planItems");

  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  // THE REF GOES ON THE ALWAYS-RENDERED CONTENT DIV BELOW, not on SessionSvg's
  // own wrapper. This effect runs once, on mount, and returns early when the
  // host is not there — but while the lane is still loading, none of the three
  // branches below render SessionSvg at all, so a ref that only existed on
  // SessionSvg's own div was never there yet when this ran, and — deps being
  // `[]` — never got a second chance once the lane finished loading and
  // SessionSvg finally mounted. The chart stayed at its 640px default,
  // letterboxed in its card, for the rest of the page's life.
  // history-chart.tsx hit the identical bug the same way and fixed it the
  // same way; see its own "THE REF GOES ON BOTH BRANCHES" note.
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      // jsdom reports 0 for every box; keep the default rather than collapsing.
      if (w > 0) setWidth(Math.max(320, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const measure = useMemo(() => makeTextMeasurer(LANE_FONT), []);
  // The window is THIS session's own start/finish, never derived from spans
  // or plan items — see sessionWindow's own comment for the bug that was.
  const win = sessionWindow(state.sessionStartedAt, state.finishedAt, { live, nowMs: now });
  // Plain calls, not useMemo: both are a single small array map (a session
  // has tens of spans and items at most), so memoizing them buys nothing and
  // `rawPlanItems`, computed fresh above from two hook results, would just
  // move the "changes every render" problem into a dependency array instead
  // of removing it.
  const sessionOnlySpans = win ? sessionSpans(spans, win.startMs, win.endMs) : [];
  const timerItems = timerLaneItems(sessionOnlySpans);
  const planItems = win ? clipToSession(planLaneItems(rawPlanItems), win.startMs, win.endMs) : [];

  const [hoverX, setHoverX] = useState<number | null>(null);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (r.width === 0) return;
    const x = ((e.clientX - r.left) / r.width) * width;
    setHoverX(x);
  }
  function onLeave() {
    setHoverX(null);
  }

  return (
    <div id="s-session" className="su-card flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold text-fg">Session</h2>
        <span className="flex-1" />
        <CustomizePopover
          label="Customize the Session chart"
          groups={[{ id: "lanes", label: "Lanes", options: [{ key: "planItems", label: "Plan items" }] }]}
          selected={laneKeys}
          onToggle={(key) => {
            const err = toggleLane(key);
            if (err) toast.error(`Couldn't remember that: ${err.message}`);
          }}
        />
      </div>
      <div ref={hostRef} className="flex flex-col gap-3 p-4">
        {!loaded ? null : !serviceKey ? (
          live ? (
            // Distinct from the idle empty note below: the timer IS running —
            // a plan item auto-started it, or the operator pressed Start,
            // with no PCO service open. Saying "the chart draws once the
            // timer starts" while a clock is
            // visibly running is false, and this is exactly the failure case
            // emitRaw's own `raw: no service open, session not archived` log
            // line exists for: this session's presses are not being written
            // anywhere, so there will never be anything for this chart, or
            // Past sessions, to show for it.
            <EmptyNote text="No service is open, so this session's presses are not being archived and the chart has nothing to draw." />
          ) : (
            <EmptyNote text="No session recorded yet — the chart draws once the timer starts." />
          )
        ) : error ? (
          // Distinct from BOTH empty notes below on purpose — a failed fetch
          // is not a session that recorded nothing, and must never read as
          // one. The lane refetches on a live baptism:state push, which only
          // a press sends, and on mount. A finished session gets no push
          // until someone presses something, so it is told to reload rather
          // than promised a retry that may never come.
          <ErrorNote
            text={
              live
                ? "Couldn't load the timing lane — it tries again at the next press."
                : "Couldn't load the timing lane. Reload the page to try again."
            }
          />
        ) : !win || sessionOnlySpans.length === 0 ? (
          <EmptyNote text="No timing detail was recorded for this session." />
        ) : (
          <SessionSvg
            svgRef={svgRef}
            width={width}
            win={win}
            live={live}
            now={now}
            reduced={reduced}
            measure={measure}
            spans={sessionOnlySpans}
            timerItems={timerItems}
            planItems={planItems}
            showPlanLane={showPlanLane}
            hoverX={hoverX}
            onMove={onMove}
            onLeave={onLeave}
            onHover={onHover}
          />
        )}
        {/* Only when the plan lane would otherwise draw and just look empty
            with no explanation — an operator with Plan items toggled off has
            nothing to be told about a fetch this lane doesn't need either
            way. The timer lane above is unaffected either way: this is a
            plan-only fetch. */}
        {showPlanLane && planError && (
          <p role="alert" className="text-caption2 text-danger-11">
            Plan items could not be loaded; the log has the details.
          </p>
        )}
        <Legend />
      </div>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center text-caption1 text-fg-muted">
      {text}
    </div>
  );
}

/** A fetch that failed, not a session that recorded nothing — the same
 *  danger-toned alert banner import-layout.tsx and screen-urls-dialog.tsx use
 *  for exactly this distinction. `role="alert"` announces it immediately,
 *  unlike EmptyNote's two neutral states. */
function ErrorNote({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded-lg border border-danger-9/40 bg-danger-9/10 px-3 py-2 text-footnote text-danger-11">
      {text}
    </p>
  );
}

function Legend() {
  const swatch = (bg: string, outline?: boolean) => (
    <span
      className={outline ? "inline-block size-2.5 rounded-[2px] border border-line-strong" : "inline-block size-2.5 rounded-[2px]"}
      style={{ background: bg }}
    />
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption2 text-fg-muted">
      <span className="inline-flex items-center gap-1.5">
        {swatch("color-mix(in srgb, var(--color-accent) 78%, transparent)")}
        Testimony
      </span>
      <span className="inline-flex items-center gap-1.5">
        {swatch("color-mix(in srgb, var(--color-live-9) 72%, transparent)")}
        Baptism
      </span>
      <span className="inline-flex items-center gap-1.5">
        {swatch("var(--color-fill)", true)}
        Not counted (gap, pause)
      </span>
      <span className="inline-flex items-center gap-1.5">
        {swatch("var(--color-surface-raised)", true)}
        Plan item
      </span>
    </div>
  );
}

interface SessionSvgProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
  width: number;
  win: { startMs: number; endMs: number };
  live: boolean;
  now: number;
  reduced: boolean;
  measure: (s: string) => number;
  spans: BaptismSpan[];
  timerItems: TimerLaneItem[];
  planItems: LaneItem[];
  /** Customize's "Plan items" choice. Off, the plan lane draws nothing and
   *  the layout closes up to the timer lane's own height — see the geometry
   *  below, not a CSS hide that would leave the empty row's space behind. */
  showPlanLane: boolean;
  hoverX: number | null;
  onMove: (e: React.PointerEvent<SVGSVGElement>) => void;
  onLeave: () => void;
  onHover?: (figures: StatFigure[] | null) => void;
}

function SessionSvg({
  svgRef,
  width,
  win,
  live,
  now,
  reduced,
  measure,
  spans,
  timerItems,
  planItems,
  showPlanLane,
  hoverX,
  onMove,
  onLeave,
  onHover,
}: SessionSvgProps) {
  const plotX0 = PAD_L;
  const plotX1 = Math.max(plotX0 + 40, width - PAD_R);
  const domainStartMs = win.startMs;
  const domainEndMs = win.endMs;
  const laneOpts = { domainStartMs, domainEndMs, liveEdgeMs: domainEndMs, plotX0, plotX1 };

  const timerSegments = laneSegments(timerItems, laneOpts) as (LaneSegment & { item: TimerLaneItem })[];
  const planSegments = laneSegments(planItems, laneOpts);
  const gaps = gapSpans(spans, new Date(domainEndMs).toISOString());

  const timerLanes = Math.max(1, maxLane(timerSegments) + 1);
  const planLanes = showPlanLane ? Math.max(1, maxLane(planSegments) + 1) : 0;
  const timerY0 = PAD_T;
  const timerBandH = timerLanes * ROW_H + (timerLanes - 1) * ROW_GAP;
  const planY0 = timerY0 + timerBandH + (showPlanLane ? LANE_SPACING : 0);
  const planBandH = showPlanLane ? planLanes * ROW_H + (planLanes - 1) * ROW_GAP : 0;
  const axisY = planY0 + planBandH + 8;
  const H = axisY + AXIS_H + 6;

  const xOf = (ms: number) => {
    const span = domainEndMs - domainStartMs || 1;
    return plotX0 + ((ms - domainStartMs) / span) * (plotX1 - plotX0);
  };
  // Elapsed minutes since the session's own start ("0m", "1m", ...), not a
  // clock time — see sessionAxisTicks's own comment for why this chart does
  // not reuse history-chart's timeTicks(). keepAxisLabels is still the SAME
  // shared collision-avoidance geometry every History chart's axis uses; only
  // the ticks and the text handed to it are this chart's own.
  const axisText = (t: number) => sessionAxisLabel(t, domainStartMs);
  const ticks = useMemo(() => sessionAxisTicks(domainStartMs, domainEndMs), [domainStartMs, domainEndMs]);
  const labelledTicks = keepAxisLabels(ticks, { xOf, text: axisText, measure, plotX0, plotX1 });

  // segmentAt's own signature returns the DECLARED `LaneSegment`, which loses
  // the TimerLaneItem narrowing timerSegments carries — see the cast building
  // timerSegments above for why that narrowing is safe to assert back.
  const hoveredTimerSeg = hoverX != null
    ? (segmentAt(timerSegments, hoverX, "service") as (LaneSegment & { item: TimerLaneItem }) | null)
    : null;
  const hoveredKey = hoveredTimerSeg
    ? `${hoveredTimerSeg.item.itemId}-${hoveredTimerSeg.item.endedAt ?? "running"}`
    : "";
  const hoverFigs = hoveredTimerSeg ? timerHoverFigures(hoveredTimerSeg.item, domainEndMs) : null;
  const onHoverRef = useRef(onHover);
  useEffect(() => {
    onHoverRef.current = onHover;
  }, [onHover]);
  useEffect(() => {
    onHoverRef.current?.(hoverFigs);
    // `hoverFigs` is a fresh array every render; `hoveredKey` is what is IN it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredKey]);
  useEffect(() => () => onHoverRef.current?.(null), []);

  const lastSpan = spans[spans.length - 1];
  const running = live && !!lastSpan && lastSpan.endedAt === null;

  return (
    <div className="lane-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${H}`}
        width="100%"
        height={H}
        className="block select-none"
        role="img"
        aria-label="Baptism session timeline"
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        {ticks.map((t) => {
          const x = xOf(t);
          return (
            <g key={t}>
              <line x1={x} y1={timerY0 - 4} x2={x} y2={axisY} stroke="var(--color-line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              {labelledTicks.has(t) && (
                <text x={x} y={axisY + 14} textAnchor="middle" className="fill-fg-subtle font-mono text-[11px] tabular-nums">
                  {axisText(t)}
                </text>
              )}
            </g>
          );
        })}

        <text x={4} y={timerY0 + ROW_H / 2 + 4} className="fill-fg-subtle font-mono text-[11px]">timer</text>
        {showPlanLane && (
          <text x={4} y={planY0 + ROW_H / 2 + 4} className="fill-fg-subtle font-mono text-[11px]">plan</text>
        )}

        {gaps.map((g, i) => {
          const x0 = Math.min(plotX1, Math.max(plotX0, xOf(Date.parse(g.startedAt))));
          const x1 = Math.min(plotX1, Math.max(plotX0, xOf(Date.parse(g.endedAt))));
          const w = Math.max(0, x1 - x0);
          if (w <= 0) return null;
          const fits = measure("not counted") + LANE_LABEL_PADDING <= w;
          return (
            <g key={`gap-${i}`} data-gap={i}>
              <rect
                x={x0}
                y={timerY0}
                width={w}
                height={ROW_H}
                rx={3}
                fill="var(--color-fill)"
                stroke="var(--color-line-strong)"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              {fits && (
                <text x={x0 + w / 2} y={timerY0 + ROW_H / 2 + 4} textAnchor="middle" className="fill-fg-subtle font-mono text-[10px]">
                  not counted
                </text>
              )}
            </g>
          );
        })}

        {timerSegments.filter((s) => s.visible).map((seg) => {
          const y = timerY0 + seg.lane * (ROW_H + ROW_GAP);
          const w = Math.max(0, seg.x1 - seg.x0);
          const label = laneLabel(seg.item, w, measure);
          const isTestimony = seg.item.kind === "testimony";
          const hovered = hoveredTimerSeg?.item.itemId === seg.item.itemId;
          const openLive = live && seg.item.endedAt === null;
          return (
            <g key={seg.item.itemId} data-timer-segment={seg.item.itemId}>
              <rect
                x={seg.x0}
                y={y}
                width={w}
                height={ROW_H}
                rx={4}
                fill={
                  isTestimony
                    ? "color-mix(in srgb, var(--color-accent) 78%, transparent)"
                    : "color-mix(in srgb, var(--color-live-9) 72%, transparent)"
                }
                stroke={hovered ? "var(--color-accent)" : openLive ? "var(--color-fg)" : undefined}
                strokeWidth={hovered ? 2 : openLive ? 1.5 : undefined}
                vectorEffect="non-scaling-stroke"
              />
              {label.kind !== "none" && (
                <text
                  x={seg.x0 + w / 2}
                  y={y + ROW_H / 2 + 4}
                  textAnchor="middle"
                  pointerEvents="none"
                  className="fill-on-accent text-[11px] font-semibold"
                >
                  {label.text}
                </text>
              )}
            </g>
          );
        })}

        {showPlanLane &&
          planSegments.filter((s) => s.visible).map((seg, i) => {
            const y = planY0 + seg.lane * (ROW_H + ROW_GAP);
            const w = Math.max(0, seg.x1 - seg.x0);
            const label = laneLabel(seg.item, w, measure);
            return (
              <g key={`${seg.item.itemId}-${i}`} data-plan-segment={seg.item.itemId}>
                <rect
                  x={seg.x0}
                  y={y}
                  width={w}
                  height={ROW_H}
                  rx={4}
                  fill="var(--color-surface-raised)"
                  stroke="var(--color-line-strong)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                {label.kind !== "none" && (
                  <text x={seg.x0 + 8} y={y + ROW_H / 2 + 4} pointerEvents="none" className="fill-fg-muted text-[11px]">
                    {label.text}
                  </text>
                )}
              </g>
            );
          })}

        {running && (
          <>
            <line
              x1={xOf(now)}
              y1={timerY0 - 6}
              x2={xOf(now)}
              y2={axisY}
              stroke="var(--color-fg)"
              strokeWidth={1}
              opacity={0.45}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              data-live-edge=""
              cx={xOf(now)}
              cy={timerY0 - 6}
              r={4}
              fill="var(--color-live-9)"
              className={reduced ? undefined : "su-history-pulse"}
            />
          </>
        )}
      </svg>
    </div>
  );
}
