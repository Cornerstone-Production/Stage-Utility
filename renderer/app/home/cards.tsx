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

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronRightIcon,
  ArrowUpIcon,
  ArrowDownIcon,
} from "lucide-react";

import { AppLink } from "../app-link";
import { readinessChecks, outstanding, type ReadinessCheck } from "./readiness";
import { flashTarget } from "../flash";
import { cn } from "../../lib/cn";
import { invoke, onNotification } from "../../lib/api";
import { computeOverview, type OverviewData, type Trend } from "../../settings/sections/overview-data";
import { computePcoTimer, fmtDuration } from "../../main/pco-timer";
import { useObsState } from "../../main/use-obs-state";
import { useReaperState } from "../../main/use-reaper-state";
import { useSplState } from "../../main/use-spl-state";
import { recordingStat, loudestSpl } from "../recording-status";

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

function Stat({
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
  tone?: "danger" | "live";
}) {
  const body = (
    <>
      <span className="block text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
        {label}
      </span>
      <span
        className={cn(
          "block text-title2 font-medium font-mono tabular-nums mt-0.5",
          tone === "danger" && "text-danger-11",
          tone === "live" && "text-live-11",
        )}
      >
        {value}
      </span>
      {sub && <span className="block text-caption1 text-fg-subtle">{sub}</span>}
    </>
  );
  const className = "rounded-xl border border-line bg-surface px-4 py-3";
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
    <section className="rounded-xl border border-line bg-surface px-4 py-3">
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
  return (
    <section className="rounded-xl border border-line bg-surface overflow-hidden">
      <header className="flex items-baseline gap-2 px-4 py-3 border-b border-line">
        <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          Ready for the next service
        </h2>
        <span className="ml-auto text-caption1 text-fg-subtle">
          {todo.length === 0 ? "everything set" : `${todo.length} to sort out`}
        </span>
      </header>
      {checks.map((c) => (
        <CheckRow key={c.id} check={c} />
      ))}
    </section>
  );
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
    <section className="rounded-xl border border-line bg-surface overflow-hidden">
      <header className="flex items-baseline gap-2 px-4 py-3 border-b border-line">
        <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          Recent {scope.toLowerCase()}
        </h2>
        <AppLink to="/history" className="ml-auto text-caption1 text-accent hover:underline">
          Open History
        </AppLink>
      </header>
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-line">
        <Headline label="Attendance" value={overview.avgAttendance} sub="average" trend={overview.attTrend} />
        <Headline label="Peak" value={overview.peakAttendance} sub={overview.peakSub} />
        <Headline label="Length" value={overview.avgLength} sub="average" />
        <Headline label="Start" value={overview.avgStart} sub="average" />
      </div>
    </section>
  );
}

/**
 * Live service status — the timer and the current item own the screen, and
 * everything else is a glance.
 *
 * The timer maths is NOT reimplemented here: computePcoTimer already mirrors
 * PCO's semantics and fmtDuration already formats it. The dashboard, the stage
 * display and the context bar all use that pair; a fourth copy would be a fourth
 * place for the same bug.
 *
 * Recording and SPL come first: mid-service they are the two things you cannot
 * recover after the fact.
 */
export function LiveStatusCard({
  pcoLive,
  now,
  skewMs,
  onlineOutputIds,
  outputCount,
}: {
  pcoLive: PcoLiveDTO | null;
  now: number;
  skewMs: number;
  onlineOutputIds: readonly string[];
  outputCount: number;
}) {
  const timer = computePcoTimer(pcoLive, now, skewMs);
  const obs = useObsState();
  const reaper = useReaperState();
  const spl = useSplState();
  const rec = recordingStat(obs, reaper);
  const loud = loudestSpl(spl);

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-xl border border-line bg-surface px-5 py-5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span
            className={cn(
              "text-large-title font-medium font-mono tabular-nums leading-none",
              timer?.over && "text-danger-11",
            )}
            style={{ fontSize: "clamp(2.25rem, 6vw, 3.25rem)" }}
          >
            {timer ? fmtDuration(timer.seconds) : "—"}
          </span>
          {timer?.label && <span className="text-headline text-fg">{timer.label}</span>}
        </div>
        {pcoLive?.nextItemTitle && (
          <p className="text-footnote text-fg-subtle mt-2.5">Next · {pcoLive.nextItemTitle}</p>
        )}
      </section>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <Stat label="Recording" value={rec.value} sub={rec.sub} tone={rec.tone} />
        <Stat label="SPL" value={loud.value} sub={loud.sub} />
        <Stat
          label="Screens"
          value={`${onlineOutputIds.length}/${outputCount}`}
          sub={onlineOutputIds.length === outputCount ? "all connected" : "one or more offline"}
          to="/screens"
          tone={onlineOutputIds.length === outputCount ? undefined : "danger"}
        />
        <Stat label="History" value="open" sub="timing and attendance" to="/history" />
      </div>
    </div>
  );
}

/** The readiness card from a state snapshot, for callers that have no presence
 *  hook — a wall display has no business subscribing to one, and a check that
 *  lags by a poll beats one that only works inside the shell. */
export function ReadinessCardFromState({ state }: { state: StageState }) {
  const online = (state.outputs ?? []).filter((o) => o.viewId).map((o) => o.id);
  return <ReadinessCard checks={readinessChecks(state, online)} />;
}
