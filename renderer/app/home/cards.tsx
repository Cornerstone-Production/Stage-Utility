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
import { readinessChecks, outstanding, splitByPresence, type ReadinessCheck } from "./readiness";
import { usePlanChecklist } from "../../main/use-plan-checklist";
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
import { computeOverview, trendColor, type OverviewData, type Trend } from "../../settings/sections/overview-data";
import { computePcoTimer, fmtDuration } from "../../main/pco-timer";
import { useObsState } from "../../main/use-obs-state";
import { usePvpState, usePvpSkewMs } from "../../main/use-pvp-state";
import { PvpLayerRow } from "../../main/pvp-layer-row";
import { visibleLayers } from "../../main/pvp-object";
import { PvpNowObject } from "../../main/pvp-now";
import { useReaperState } from "../../main/use-reaper-state";
import { useSplState } from "../../main/use-spl-state";
import { recordIndicator, recorders, streamIndicator, streamers, loudestSpl } from "../recording-status";
import { useResiState, useYouTubeState } from "../../main/use-stream-state";
import { Readout } from "../../main/readout";
import { useScoresState } from "../../main/use-scores-state";
import { inkFor } from "../../main/score-ink";
import { pickGame } from "../../main/scores-object";

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
  "home-scores": true,
  "home-screens": true,
  "home-pvp": true,
  "home-pvp-now": true,
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
      className={cn("inline-flex items-center gap-0.5 text-caption1", trendColor(trend.tone))}
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
  // The plan's own checklist, written in Planning Center. Rows an operator ticks
  // by hand, alongside the checks the app works out for itself.
  const { rows: planRows, toggle } = usePlanChecklist();

  const todo = outstanding(checks);
  const planTodo = planRows.filter((r) => !r.done);
  // Measure the box rather than guess at it: this card is placed at four
  // different tile sizes on Home and at any size at all on a canvas, so "how
  // many rows fit" is not something the caller can be trusted to pass in.
  const { wrapRef, rows } = useRowBudget(ROW_HEIGHT_PX, HEADER_PX);

  // Short box: what still needs doing, and nothing else. A widget does not
  // scroll and must not clip, so it shows LESS — the passing checks are the
  // ones you do not need to see, and hiding the outstanding ones would make
  // "2 to sort out" a lie about the rows underneath it.
  //
  // The plan's rows queue behind the app's own, because a screen that is not
  // routed stops the service in a way that an unticked job does not.
  const total = checks.length + planRows.length;
  const budget = Math.max(1, rows);
  const shownChecks = total <= budget ? checks : todo.slice(0, budget);
  const shownPlan =
    total <= budget ? planRows : planTodo.slice(0, Math.max(0, budget - shownChecks.length));
  const hidden = total - shownChecks.length - shownPlan.length;
  const stillToDo = todo.length + planTodo.length;

  return (
    <section ref={wrapRef} className="flex h-full w-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-line px-4 py-3">
        <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          Ready for the next service
        </h2>
        <span className="ml-auto text-caption1 text-fg-subtle">
          {stillToDo === 0 ? "everything set" : `${stillToDo} to sort out`}
        </span>
      </header>
      {shownChecks.map((c) => (
        <CheckRow key={c.id} check={c} />
      ))}
      {shownPlan.map((r) => (
        <PlanCheckRow key={r.key} row={r} onToggle={() => void toggle(r.key, !r.done)} />
      ))}
      {hidden > 0 && (
        <p className="px-4 py-2 text-caption1 text-fg-subtle">
          {stillToDo > shownChecks.length + shownPlan.length
            ? `+${stillToDo - shownChecks.length - shownPlan.length} more to sort out`
            : `${hidden} already set`}
        </p>
      )}
    </section>
  );
}

/**
 * One row from the plan's notes.
 *
 * A SQUARE mark, where a derived check draws a round one. The shapes carry the
 * difference: a round mark reports something the app worked out and cannot be
 * ticked, a square one is a box a person ticks. Drawing both as circles made
 * tapping a derived check look like it should do something, and it never can —
 * the next state broadcast would undo it.
 */
function PlanCheckRow({
  row,
  onToggle,
}: {
  row: { key: string; text: string; done: boolean };
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={row.done}
      className="flex w-full items-center gap-3 border-b border-line px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
    >
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded",
          row.done ? "bg-accent text-on-accent" : "border border-fg-subtle",
        )}
        aria-hidden="true"
      >
        {row.done && <CheckIcon className="size-2.5" strokeWidth={3} />}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-body", row.done ? "text-fg-muted line-through" : "text-fg")}>
        {row.text}
      </span>
    </button>
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

/**
 * ProVideoPlayer's layers, at a glance.
 *
 * Up to three layers with content. `visibleLayers` is the SAME filter the wall
 * object uses and PvpLayerRow is the same row, so the two surfaces cannot
 * disagree about whether a layer is live — which matters here more than usual,
 * because the field that would make them disagree (`playingItem`) never clears
 * and was wrong on four layers out of five at rest.
 *
 * IT CARRIES A CAPTION, which is the reason this card was rebuilt. Every other
 * card on the page says what it is — ProPresenter, Recording, People — and this
 * one was three rows of bare text that could have belonged to any integration in
 * the building. The tally on the right sits where Readiness puts "2 to sort out"
 * and where Recording and Streaming put their state.
 *
 * No preview image, and there is no version of this card that has one: PVP
 * exposes no thumbnail or frame endpoint at all.
 */
export function PvpCard({ now, showProgress = false }: { now: number; showProgress?: boolean }) {
  const pvp = usePvpState();
  // PVP's own clock offset rather than the PCO-derived one this card is handed:
  // the countdown below must not go wrong because Planning Center is down.
  const skewMs = usePvpSkewMs(pvp);
  const rows = visibleLayers(pvp?.layers ?? [], { type: "pvp-layers", show: "with-content" });
  // playbackRate, never isPlaying — the one rule this integration turns on.
  const rolling = rows.filter((l) => l.playbackRate > 0).length;

  // Three different nothings, for the reason the wall object's emptyReason
  // exists: one is a machine to go and look at, one is not, and one is that we
  // have not heard yet.
  if (!pvp) return <Stat label="ProVideoPlayer" value="—" />;
  if (!pvp.connected) return <Stat label="ProVideoPlayer" value="Offline" />;
  if (rows.length === 0) return <Stat label="ProVideoPlayer" value="Nothing on screen" />;

  return (
    // STAT_CARD, matching the Stat fallbacks above: home-pvp is a BARE type, so
    // nothing upstream supplies the chrome, and without this the card lost its
    // box at exactly the moment it had something to show.
    <div className={`${STAT_CARD} min-w-0`}>
      <div className="flex shrink-0 items-baseline gap-2">
        <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          ProVideoPlayer
        </h2>
        {/* "on screen", NOT "playing".
            `rows` is the with-content filter, which counts a paused clip and a
            still — and this whole widget exists because ProVideoPlayer's own
            "playing" flag says true for a graphic that is not moving. The tally
            would have read "3 of 11 playing" with nothing rolling, in green,
            which is the same lie one level up. The colour follows the same rule:
            it is live only when something actually is. */}
        <span
          className={cn(
            "ml-auto font-mono text-caption2 tabular-nums",
            rolling > 0 ? "text-live-11" : "text-fg-subtle",
          )}
        >
          {rows.length} of {pvp.layers.length} on screen
        </span>
      </div>
      {/* Three, not all of them. A Home tile is a glance; the wall object is
          where an operator goes to see the whole stack. */}
      {/* text-fg, not inheritance. Home's grid is a kiosk surface that is
          near-black in BOTH themes, and a row with no colour of its own came out
          black on black there — measured at 1.06:1 on two other spans before
          this. The rows themselves inherit, so the same component still takes a
          wall object's chosen colour. */}
      <div className="mt-1.5 flex min-w-0 flex-col gap-0.5 text-caption1 text-fg">
        {rows.slice(0, 3).map((l) => (
          <PvpLayerRow
            key={l.uuid}
            layer={l}
            sampledAt={pvp.sampledAt}
            now={now}
            skewMs={skewMs}
            showProgress={showProgress}
          />
        ))}
        {rows.length > 3 && (
          <span className="text-caption2 text-fg-subtle">+{rows.length - 3} more</span>
        )}
      </div>
    </div>
  );
}

/**
 * ProVideoPlayer as ONE reading — what is up right now, and how long is left.
 *
 * The SAME component the wall object draws, so the two cannot disagree about
 * which layer is chosen, when a still gets a countdown (never), or what "next"
 * means. Home supplies only the card and `uniform`, which is what makes this a
 * tile in a grid of same-height tiles rather than a widget filling its box.
 */
export function PvpNowCard({
  now,
  showProgress = true,
  showNextCue = true,
}: {
  now: number;
  showProgress?: boolean;
  showNextCue?: boolean;
}) {
  const pvp = usePvpState();
  const skewMs = usePvpSkewMs(pvp);
  return (
    <div className={STAT_CARD}>
      <PvpNowObject
        config={{ showProgress, showNextCue }}
        status={pvp}
        now={now}
        skewMs={skewMs}
        uniform
      />
    </div>
  );
}

/**
 * Followed scores, in Home's voice.
 *
 * NOT the wall strip, and this is the one deliberate departure from the plan's
 * text: it said "each as a compact ScoreStrip", and the mockup this plan
 * implements says the opposite, with a reason -- "no colour block here on
 * purpose: a Home tile sits beside quiet cards, and a red panel would out-shout
 * the readiness list next to it. The colour survives as the chip." A tile of
 * brand colour between Readiness and Next service is exactly that panel.
 *
 * What is NOT duplicated is the part that could be wrong: the ink over a team's
 * colour still comes from score-ink, so a chip and a wall widget cannot disagree
 * about whether the Packers take white text.
 *
 * The trailing team is dimmed rather than the leader emphasised. Everything on
 * this page is already at full strength, so making one row louder would make the
 * card louder than its neighbours; making the loser quieter says the same thing
 * and leaves the card where it sits.
 */
export function ScoresCard({ game = "auto" }: { game?: "auto" | string }) {
  const scores = useScoresState();
  const all = scores?.games ?? [];
  // The one whose status heads the card. THE SAME function the wall object uses,
  // so "auto" and a pinned team mean the same thing on both surfaces and a pin
  // hands over at the same moment on each.
  const featured = pickGame(scores, game);
  // Led by the game the card is about, the rest behind it in start order. The
  // list was the first three by start time, which on a pinned card is three
  // games that need not include the pinned one.
  const games = featured ? [featured, ...all.filter((g) => g !== featured)] : all;

  if (games.length === 0) {
    // Three different facts, kept apart. "No games today" for a failed request
    // is a factual lie about the operator's own schedule.
    const why = scores?.error
      ? "Scores unavailable"
      : scores?.connected
        ? "No games today"
        : "No teams followed";
    return <Stat label="Scores" value={why} />;
  }

  return (
    <section className="home-scores flex h-full w-full flex-col px-4 py-3">
      <div className="flex items-baseline gap-2">
        <h2 className="shrink-0 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          Scores
        </h2>
        {featured && (
          <span
            className={cn(
              // ONE LINE, always. shortDetail is whatever ESPN sent and falls
              // back to the longer `detail`, so a game that has not started
              // reads "8/30 - 1:40 PM EDT" rather than "Top 2nd" -- eighteen
              // characters where the card budgeted for seven. Wrapped, it put a
              // second 13px line into a card with 3px spare, and the venue was
              // the only box left able to give: its text came out sliced through
              // the middle of the glyphs. Truncating is the same answer the team
              // name and the venue already use in this card.
              "ml-auto min-w-0 truncate font-mono text-caption2 text-fg-subtle",
              featured.state === "in" && !featured.delayed && "home-scores-live",
            )}
          >
            {featured.shortDetail}
          </span>
        )}
      </div>

      {/* mt-1 here and pt-1 on the venue below are part of the card's height
          budget at a 120px tile, not free spacing -- home-scores-fit.test.ts
          holds the total and .home-scores-list in styles.css says why. */}
      <div className="home-scores-list mt-1">
        {games.slice(0, 3).map((g) => (
          <div key={g.eventId} className="home-scores-game">
            <ScoresRow team={g.away} trailing={behind(g.away, g.home)} />
            <ScoresRow team={g.home} trailing={behind(g.home, g.away)} />
          </div>
        ))}
      </div>

      {featured?.venue && (
        <p className="home-scores-foot mt-auto pt-1 text-caption2 text-fg-subtle">
          {featured.venue}
        </p>
      )}
    </section>
  );
}

/** Behind, not merely "not ahead": a tied game dims neither side. */
function behind(a: ScoreTeamDTO, b: ScoreTeamDTO): boolean {
  return a.score != null && b.score != null && a.score < b.score;
}

function ScoresRow({ team, trailing }: { team: ScoreTeamDTO; trailing: boolean }) {
  const ink = inkFor(team.color);
  return (
    <div className={cn("home-scores-row", trailing && "is-trailing")}>
      <span
        className="home-scores-chip"
        // The chip is the ONLY place a team colour appears on this page, and its
        // ink is chosen by contrast rather than fixed -- roughly a third of the
        // league is unreadable in white.
        style={{ background: team.color ?? "var(--color-fill)", color: ink }}
      >
        {team.abbreviation}
      </span>
      <span className="home-scores-name">{team.name}</span>
      <span className="home-scores-value">{team.score ?? "\u2014"}</span>
    </div>
  );
}

/**
 * How many screens have a browser attached, of how many exist.
 *
 * Takes the screens and the presence set rather than two numbers, so the
 * intersection cannot be skipped at a call site. Handed a count, this card once
 * read "3/2 connected": presence is not a subset of the screens that exist, and
 * a page left open on a deleted one keeps heartbeating.
 */
export function ScreensCard({
  outputs,
  onlineOutputIds,
}: {
  outputs: readonly Output[];
  onlineOutputIds: readonly string[];
}) {
  const online = splitByPresence(outputs, onlineOutputIds).online.length;
  const total = outputs.length;
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
 * One card, by type. THE dispatch — there is not a second one.
 *
 * Home and the layout renderer both come through here, so a fifth card is added
 * in one place rather than two that drift. The `never` in the default is what
 * makes a missing case a compile error instead of a blank space on the front
 * page.
 */
export function HomeCard({
  config,
  state,
  pcoLive,
  now,
  skewMs,
  onlineOutputIds,
  secondsToStart,
}: {
  /**
   * The card's WHOLE config, not just its type.
   *
   * It was the type alone, and that made every setting Home's own card menu
   * writes a no-op: `togglesFor` offered "Elapsed time" on a streaming card and
   * wrote it into the object, and the card that drew it never looked. The menu
   * and the inspector both write here, so both have to be readable from here.
   */
  config: Extract<LayoutObjectConfig, { type: HomeCardType }>;
  state: StageState;
  pcoLive: PcoLiveDTO | null;
  now: number;
  skewMs: number;
  /**
   * Output ids with a live heartbeat, from `useDisplayPresence` by way of
   * `LayoutRenderCtx.onlineOutputIds` — the single supplier, on every path.
   *
   * This used to be `outputs.filter(o => o.viewId)`, which is ROUTED, not
   * connected: a screen that was routed and unplugged counted as online for
   * ever, so "all connected" on the front page meant nothing at all.
   */
  onlineOutputIds: readonly string[];
  secondsToStart: number | null;
}) {
  const c = config;
  switch (c.type) {
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
    case "home-scores":
      return <ScoresCard game={c.game ?? "auto"} />;
    case "home-streaming-resi":
      return <StreamingCard platform="Resi" now={now} />;
    case "home-streaming-youtube":
      return <StreamingCard platform="YouTube" now={now} />;
    case "home-spl":
      return <SplCard />;
    case "home-pvp":
      return <PvpCard now={now} showProgress={c.showProgress ?? false} />;
    case "home-pvp-now":
      return (
        <PvpNowCard
          now={now}
          showProgress={c.showProgress ?? true}
          showNextCue={c.showNextCue ?? true}
        />
      );
    case "home-screens":
      return <ScreensCard outputs={state.outputs ?? []} onlineOutputIds={onlineOutputIds} />;
    case "home-next-service":
      return <NextServiceCard state={state} secondsToStart={secondsToStart} />;
    case "home-readiness":
      return <ReadinessCard checks={readinessChecks(state, onlineOutputIds)} />;
    case "home-recent-services":
      return <RecentServicesCard state={state} />;
    default: {
      const _never: never = c;
      void _never;
      return null;
    }
  }
}
