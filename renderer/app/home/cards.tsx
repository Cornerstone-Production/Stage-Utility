// Home's cards.
//
// One component per card, exported, so the Home tab and the layout renderer draw
// THE SAME markup rather than two copies that drift. That was already true of
// the next-service and readiness cards; this file finishes the job for the other
// two and puts all four in one place.
//
// The mode split — which cards belong to a running service and which to the rest
// of the week — is NOT here. It lives in home-cards.ts beside the ordering, so a
// card can be rendered anywhere without dragging Home's rules along with it.

import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronRightIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "lucide-react";

import { AppLink } from "../app-link";
import { AttendanceTrendChart } from "../../components/attendance-trend-chart";
import { readinessChecks, outstanding, type ReadinessCheck } from "./readiness";
import type { LayoutObjectConfig } from "@main/types/views";
/**
 * The cards Home draws with its own markup. Derived from the config union so a
 * new home-* type cannot be silently left out of the switch below.
 *
 * The streaming trio is here too. They ALSO render through the shared streaming
 * case on a wall — the judgement is one function either way — but the two
 * surfaces present it differently on purpose: a wall reads one word at a
 * distance, Home reads a row of three-line cards, and a streaming card that
 * wore the wall's composition was the odd one out on the page.
 */
export type HomeCardType = Extract<LayoutObjectConfig, { type: `home-${string}` }>["type"];

import { flashTarget } from "../flash";
import { cn } from "../../lib/cn";
import { invoke, onNotification } from "../../lib/api";
import { computeOverview, type OverviewData, type Trend } from "../../settings/sections/overview-data";
import { computePcoTimer, fmtDuration } from "../../main/pco-timer";
import { useObsState } from "../../main/use-obs-state";
import { useReaperState } from "../../main/use-reaper-state";
import { useSplState } from "../../main/use-spl-state";
import { recordIndicator, recorders, streamIndicator, streamers, loudestSpl } from "../recording-status";
import { useResiState, useYouTubeState } from "../../main/use-stream-state";
import { Readout } from "../../main/readout";

/**
 * The same set as a VALUE, so a renderer can ask before it starts matching.
 *
 * `Record<HomeCardType, true>` is what makes it safe: add a home card and this
 * object stops compiling until it is listed. layout-renderer routes on this
 * ahead of its own switch, which is the whole point — the streaming trio used
 * to be caught by a case further up and drawn as a wall widget, so Home showed
 * a two-line ALL-CAPS tile in a row of three-line cards.
 */
const HOME_CARD_TYPES: Record<HomeCardType, true> = {
  "home-readiness": true,
  "home-next-service": true,
  "home-recent-services": true,
  "home-live-status": true,
  "home-recording": true,
  "home-recording-obs": true,
  "home-recording-reaper": true,
  "home-streaming": true,
  "home-streaming-resi": true,
  "home-streaming-youtube": true,
  "home-spl": true,
  "home-screens": true,
};

export function isHomeCard(
  c: LayoutObjectConfig,
): c is Extract<LayoutObjectConfig, { type: HomeCardType }> {
  return c.type in HOME_CARD_TYPES;
}

/* ── Shared bits ──────────────────────────────────────────────────────────── */

function CheckRow({ check }: { check: ReadinessCheck }) {
  const body = (
    <>
      <span
        className={cn(
          "grid place-items-center size-4 rounded-full shrink-0",
          check.ok ? "bg-live-9 text-white" : "border border-fg-subtle",
        )}
        aria-hidden="true"
      >
        {check.ok && <CheckIcon className="size-2.5" strokeWidth={3} />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-body text-fg">{check.label}</span>
        <span className="block text-caption1 text-fg-subtle truncate">{check.detail}</span>
      </span>
      {!check.ok && <ChevronRightIcon className="size-4 text-fg-subtle shrink-0" />}
    </>
  );

  // A passing check is not a link: there is nothing to fix, and making it
  // clickable invites a trip that changes nothing.
  if (check.ok || !check.route) {
    return <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0">{body}</div>;
  }
  return (
    <AppLink
      to={check.route}
      onClick={() => check.flash && flashTarget(check.flash)}
      className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 transition-colors hover:bg-fill"
    >
      {body}
    </AppLink>
  );
}

/** A trend arrow, or nothing at all when there is not enough history to judge.
 *  computeTrend returns null rather than faking a direction, and this respects
 *  that: an arrow drawn from one data point is a lie with a chevron on it. */
function TrendArrow({ trend }: { trend: Trend | null }) {
  if (!trend) return null;
  const Icon = trend.dir === "up" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-caption1",
        trend.tone === "good" && "text-ok-11",
        trend.tone === "bad" && "text-warn-11",
        trend.tone === "neutral" && "text-fg-subtle",
      )}
      title={`vs the previous ${trend.priorCount} service${trend.priorCount === 1 ? "" : "s"}`}
    >
      <Icon className="size-3" strokeWidth={2.5} />
      {trend.pct != null && `${Math.abs(Math.round(trend.pct * 100))}%`}
    </span>
  );
}

function Headline({
  label,
  value,
  sub,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: Trend | null;
}) {
  return (
    <div className="px-4 py-3">
      <span className="block text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
        {label}
      </span>
      <span className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-title3 font-medium font-mono tabular-nums text-fg">{value}</span>
        <TrendArrow trend={trend ?? null} />
      </span>
      {sub && <span className="block text-caption1 text-fg-subtle truncate">{sub}</span>}
    </div>
  );
}

/** The card every Home stat sits in. One string, so the timer and the stats
 *  cannot end up looking like different species — which is exactly what happened
 *  when only Stat drew it and the timer came out with no background at all. */
export const STAT_CARD =
  // h-full and a flex column, not a plain box: a stat sizes to its CONTENT, and
  // in a grid tile that left it floating short of the bottom edge. `block` is
  // load-bearing too — the drill-down variant renders an <a>, which is inline by
  // default, so its card collapsed to a sliver with the text hanging outside it.
  //
  // `relative` is what lets Readout position against the card: the idiom takes
  // the whole box and supplies its own box-relative padding, so the card's own
  // px-4 py-3 is the fallback for anything that is not a Readout.
  // NO frame of its own. Home's grid paints the tile — one radius, one hairline,
  // one ground for every tile on the page. Painting a second card in here put a
  // card inside a card, which was invisible while this filled the tile exactly
  // and obvious the moment one did not: the next-service tile drew a smaller
  // bordered box with dead space under it.
  "relative flex h-full w-full flex-col justify-center px-4 py-3";

/**
 * A Home stat — THE dashboard-sized instance of the one widget idiom.
 *
 * Not a second copy of it. This composition is where the idiom came from, and
 * for a while it was also the one thing not rendered by the shared component:
 * Home's cards sized their value with a fixed type scale while every stage
 * widget derived its own from its box. Put side by side in the same grid — which
 * is exactly what Home does, since a stage widget can be added to it — a card
 * read at a third the size of the widget beside it.
 *
 * So it goes through Readout too, and a tile is a tile whatever is in it.
 */
export function Stat({
  label,
  value,
  sub,
  to,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  to?: string;
  /** Only the two colours a stat ever earns. Everything else — offline,
   *  standby, off air — is the page's own foreground: on Home the caption and
   *  the sub-line carry the grey, and a card that greyed its value too read as
   *  disabled beside the ones that had not. */
  tone?: "danger" | "live";
}) {
  const body = (
    <Readout
      caption={label}
      value={value}
      sub={sub}
      // The tone colours are the app's semantic tokens, not the display palette:
      // a stat on Home is read on Home. Readout leaves the value at the inherited
      // foreground when this is null, which inside .kiosk-surface is the same
      // white a display uses.
      valueColor={
        tone === "danger" ? "var(--color-danger-11)"
        : tone === "live" ? "var(--color-live-11)"
        : null
      }
      mono
    />
  );
  const className = STAT_CARD;
  return to ? (
    <Link to={to as never} className={cn(className, "transition-colors hover:border-line-strong")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * History's records, for the headline figures.
 *
 * Fetched here rather than threaded down from the route: Home is the only other
 * consumer, and the same SSE channels History listens to keep it current, so a
 * service that finishes on Sunday updates Thursday's headline without a reload.
 */
function useHistoryRecords() {
  const [list, setList] = useState<ServiceTimeline[] | null>(null);
  const [attList, setAttList] = useState<ServiceAttendance[]>([]);

  useEffect(() => {
    let alive = true;
    invoke<ServiceTimeline[]>("serviceTimeline:list")
      .then((l) => { if (alive) setList(l ?? []); })
      .catch(() => { if (alive) setList([]); });
    invoke<ServiceAttendance[]>("attendance:listHistory")
      .then((a) => { if (alive) setAttList(a ?? []); })
      .catch(() => { if (alive) setAttList([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const offTl = onNotification("service-timeline:history", (p: unknown) => {
      const rec = p as ServiceTimeline | null;
      if (!rec) return;
      setList((prev) => {
        if (!prev) return prev;
        const i = prev.findIndex((s) => s.serviceKey === rec.serviceKey);
        if (i === -1) return [rec, ...prev];
        const next = prev.slice();
        next[i] = rec;
        return next;
      });
    });
    const offAtt = onNotification("attendance:history", (p: unknown) => {
      const rec = p as ServiceAttendance | null;
      if (!rec) return;
      setAttList((prev) => {
        const i = prev.findIndex((a) => a.serviceKey === rec.serviceKey);
        if (i === -1) return [rec, ...prev];
        const next = prev.slice();
        next[i] = rec;
        return next;
      });
    });
    return () => { offTl(); offAtt(); };
  }, []);

  return { list, attList };
}

/* ── The cards ────────────────────────────────────────────────────────────── */

export function NextServiceCard({
  state,
  secondsToStart,
}: {
  state: StageState;
  secondsToStart?: number | null;
}) {
  return (
    // h-full, and no frame: the grid draws the tile. Without the height this sized
    // to its content and left the rest of the tile empty below it — the reported
    // "card inside a card".
    <section className="flex h-full w-full flex-col justify-center px-4 py-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          Next service
        </h2>
        {secondsToStart != null && secondsToStart > 0 && (
          <span className="ml-auto font-mono tabular-nums text-callout text-fg">
            in {fmtDuration(secondsToStart)}
          </span>
        )}
      </div>
      <p className="mt-1 text-body text-fg">
        {state.planTitle ?? "No plan selected"}
      </p>
      <p className="text-caption1 text-fg-subtle">
        {[state.serviceTypeName, state.planSeriesTitle, state.planDates]
          .filter(Boolean)
          .join(" · ") || "Choose a service type and plan below"}
      </p>
    </section>
  );
}

export function ReadinessCard({ checks }: { checks: readonly ReadinessCheck[] }) {
  const todo = outstanding(checks);
  // Measure the box rather than guess at it: this card is placed at four
  // different tile sizes on Home and at any size at all on a canvas, so "how
  // many rows fit" is not something the caller can be trusted to pass in.
  const { wrapRef, rows } = useRowBudget(ROW_HEIGHT_PX, HEADER_PX);

  // Short box: what still needs doing, and nothing else. A widget does not
  // scroll and must not clip, so it shows LESS — the passing checks are the
  // ones you do not need to see, and hiding the outstanding ones would make
  // "2 to sort out" a lie about the rows underneath it.
  const shown = rows >= checks.length ? checks : todo.slice(0, Math.max(1, rows));
  const hidden = checks.length - shown.length;

  return (
    <section ref={wrapRef} className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-line px-4 py-3">
        <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          Ready for the next service
        </h2>
        <span className="ml-auto text-caption1 text-fg-subtle">
          {todo.length === 0 ? "everything set" : `${todo.length} to sort out`}
        </span>
      </header>
      {shown.map((c) => (
        <CheckRow key={c.id} check={c} />
      ))}
      {hidden > 0 && (
        <p className="px-4 py-2 text-caption1 text-fg-subtle">
          {todo.length > shown.length
            ? `+${todo.length - shown.length} more to sort out`
            : `${hidden} already set`}
        </p>
      )}
    </section>
  );
}

/** One check row, measured once so the budget above is not a guess. */
const ROW_HEIGHT_PX = 52;
const HEADER_PX = 45;

/**
 * How many rows fit in this card, watched as it resizes.
 *
 * A widget is a fixed box: it cannot scroll and must not clip, so it has to know
 * how much room it has and show that much.
 */
function useRowBudget(rowPx: number, headerPx: number) {
  const wrapRef = useRef<HTMLElement | null>(null);
  const [rows, setRows] = useState(99);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setRows(Math.max(1, Math.floor((el.clientHeight - headerPx) / rowPx)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowPx, headerPx]);
  return { wrapRef, rows };
}

/**
 * Recent services — headlines only, and every one of them a way INTO History.
 *
 * Home restating History in full is how the two would drift apart; this is a
 * glance with a door. The figures come from computeOverview, the same function
 * History's Overview uses, for exactly that reason.
 *
 * Renders nothing until something has been recorded: a row of "—" teaches an
 * operator that this card is broken.
 */
export function RecentServicesCard({ state }: { state: StageState }) {
  const { list, attList } = useHistoryRecords();

  // Scoped to the ACTIVE service type, like History's Overview — an Events night
  // must not show up under a Weekend heading. asOf is null: on Home the question
  // is "how have we been doing lately", which means everything up to now.
  const overview: OverviewData = computeOverview(
    list,
    attList,
    null,
    state.serviceTypeId,
    state.serviceTypeName,
  );

  if (!(overview.attPoints.length > 0 || list?.length)) return null;
  const scope = overview.scopeName ?? "services";

  return (
    // h-full and a column, because a widget occupies the tile it was given. At
    // XL this card drew its header and four figures against the top edge and
    // left the remaining row blank — a third of the widest tile on the page
    // showing nothing.
    //
    // The trend chart fills it, and it is the SAME component the History tab
    // draws rather than a second chart that looks like it. It appears only when
    // the tile is tall enough to hold one: at Small or Medium the figures are
    // the whole widget, which is what those sizes are for.
    <section className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-line px-4 py-3">
        <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          Recent {scope.toLowerCase()}
        </h2>
        <AppLink to="/history" className="ml-auto text-caption1 text-accent hover:underline">
          Open History
        </AppLink>
      </header>
      <div className="grid shrink-0 grid-cols-2 divide-x divide-y divide-line sm:grid-cols-4 sm:divide-y-0">
        <Headline label="Attendance" value={overview.avgAttendance} sub="average" trend={overview.attTrend} />
        <Headline label="Peak" value={overview.peakAttendance} sub={overview.peakSub} />
        <Headline label="Length" value={overview.avgLength} sub="average" />
        <Headline label="Start" value={overview.avgStart} sub="average" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden border-t border-line px-2 pb-1 [&:has(>*:empty)]:hidden">
        <AttendanceTrendChart points={overview.attPoints} />
      </div>
    </section>
  );
}

/**
 * The service timer — the running item's clock, what it is, and what is next.
 *
 * It used to carry recording, SPL, screens and history inside it, because Home
 * had no way to arrange four small things. The grid does, so those are their own
 * widgets now and this is one job again. The maths is NOT reimplemented:
 * computePcoTimer mirrors PCO's semantics and fmtDuration formats it, and the
 * dashboard, the stage display and the context bar all use that pair.
 */
export function LiveStatusCard({
  pcoLive,
  now,
  skewMs,
}: {
  pcoLive: PcoLiveDTO | null;
  now: number;
  skewMs: number;
}) {
  const timer = computePcoTimer(pcoLive, now, skewMs);
  // The idiom, like every other card. This was the last one drawing its own
  // markup — a clamp()'d timer with its label sitting BESIDE it on the baseline
  // and the next item below, which is the same three pieces of information the
  // composition already has places for. The label is what the number is counting
  // to, so it is the caption; the next item qualifies it, so it is the sub.
  return (
    <Stat
      label={timer?.label ?? "Service"}
      value={timer ? fmtDuration(timer.seconds) : "—"}
      sub={pcoLive?.nextItemTitle ? `Next · ${pcoLive.nextItemTitle}` : undefined}
      tone={timer?.over ? "danger" : undefined}
    />
  );
}

/**
 * Are we getting this?
 *
 * Every recorder at once, not one widget per integration — the question
 * mid-service is whether the service is being captured, and a widget reporting
 * only OBS would read as reassurance while REAPER sat stopped. A new recording
 * integration joins by being added to `recorders()`; nothing here changes.
 */
export function RecordingCard({ recorder = "any" }: { recorder?: string }) {
  const list = recorders(useObsState(), useReaperState());
  const chosen = recorder === "any" ? list : list.filter((r) => r.name === recorder);
  const ind = recordIndicator(chosen);
  // Only LIVE takes a colour. Everything else is the page's own foreground, the
  // way the SPL card's value is: on Home the caption and the sub-line carry the
  // grey, and the value is the thing you read.
  return (
    <Stat
      label={recorder === "any" ? "Recording" : recorder}
      value={ind.value}
      sub={ind.sub ?? undefined}
      tone={ind.state === "live" ? "live" : undefined}
    />
  );
}

/**
 * Every platform at once, or one of them — the recording card's twin.
 *
 * Back through Stat rather than through the wall's composition. A wall wants one
 * word in one colour at a distance; Home wants three lines that read as a row
 * with the cards beside them, and those cards are Stat.
 */
export function StreamingCard({ platform = "any", now }: { platform?: string; now: number }) {
  const list = streamers(useResiState(), useYouTubeState(), useObsState());
  // The clock comes DOWN, from the one tick the page already runs. A card that
  // started its own interval would be a second clock per streaming widget, all
  // of them a fraction out of step with the countdown above them.
  const chosen = platform === "any" ? list : list.filter((s) => s.name === platform);
  const ind = streamIndicator(chosen, now, { name: platform === "any" ? null : platform });
  return (
    <Stat
      label={platform === "any" ? "Streaming" : platform}
      value={ind.value}
      sub={ind.sub ?? undefined}
      tone={ind.state === "live" ? "live" : undefined}
    />
  );
}

/** The loudest meter right now, and which one. */
export function SplCard() {
  const loud = loudestSpl(useSplState());
  return <Stat label="SPL" value={loud.value} sub={loud.sub} />;
}

/** How many displays are connected, of how many exist. */
export function ScreensCard({ online, total }: { online: number; total: number }) {
  return (
    <Stat
      label="Screens"
      value={`${online}/${total}`}
      sub={online === total ? "all connected" : "one or more offline"}
      to="/screens"
      tone={online === total ? undefined : "danger"}
    />
  );
}

/**
 * Which screens are currently showing something, from a state snapshot.
 *
 * The fallback for callers with no presence hook: an object on a wall display
 * has no business subscribing to presence, and a count that lags by a poll beats
 * one that only works inside the shell.
 */
export function onlineFromState(state: StageState): string[] {
  return (state.outputs ?? []).filter((o) => o.viewId).map((o) => o.id);
}

/**
 * One card, by type. THE dispatch — there is not a second one.
 *
 * Home and the layout renderer both come through here, so a fifth card is added
 * in one place rather than two that drift. The `never` in the default is what
 * makes a missing case a compile error instead of a blank space on the front
 * page.
 */
export function HomeCard({
  type,
  state,
  pcoLive,
  now,
  skewMs,
  onlineOutputIds,
  secondsToStart,
}: {
  type: HomeCardType;
  state: StageState;
  pcoLive: PcoLiveDTO | null;
  now: number;
  skewMs: number;
  /** Output ids currently connected, from `onlineFromState` — the single
   *  supplier, on every path. A `useOutputPresence` hook that subscribed to the
   *  `displays:presence` SSE channel was written for this and never wired to
   *  anything; it is gone rather than left looking like a second route in. */
  onlineOutputIds: readonly string[];
  secondsToStart: number | null;
}) {
  switch (type) {
    case "home-live-status":
      return <LiveStatusCard pcoLive={pcoLive} now={now} skewMs={skewMs} />;
    case "home-recording":
      return <RecordingCard />;
    case "home-recording-obs":
      return <RecordingCard recorder="OBS" />;
    case "home-recording-reaper":
      return <RecordingCard recorder="REAPER" />;
    case "home-streaming":
      return <StreamingCard now={now} />;
    case "home-streaming-resi":
      return <StreamingCard platform="Resi" now={now} />;
    case "home-streaming-youtube":
      return <StreamingCard platform="YouTube" now={now} />;
    case "home-spl":
      return <SplCard />;
    case "home-screens":
      return <ScreensCard online={onlineOutputIds.length} total={(state.outputs ?? []).length} />;
    case "home-next-service":
      return <NextServiceCard state={state} secondsToStart={secondsToStart} />;
    case "home-readiness":
      return <ReadinessCard checks={readinessChecks(state, onlineOutputIds)} />;
    case "home-recent-services":
      return <RecentServicesCard state={state} />;
    default: {
      const _never: never = type;
      void _never;
      return null;
    }
  }
}
