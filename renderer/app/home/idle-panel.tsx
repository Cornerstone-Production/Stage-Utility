// Home, the rest of the week.
//
// Next service, this week's plan, and the readiness list — the question an
// operator actually has on a Thursday. Trends are headlines that DRILL INTO
// History rather than restating it: two surfaces computing the same number is
// how they come to disagree about it. The figures come from computeOverview,
// the same function History's Overview uses, for exactly that reason.

import { useEffect, useState } from "react";
import { AppLink } from "../app-link";
import { CheckIcon, ChevronRightIcon, ArrowUpIcon, ArrowDownIcon } from "lucide-react";
import { readinessChecks, outstanding, type ReadinessCheck } from "./readiness";
import { flashTarget } from "../flash";
import { cn } from "../../lib/cn";
import { invoke, onNotification } from "../../lib/api";
import { computeOverview, type OverviewData, type Trend } from "../../settings/sections/overview-data";
import { fmtDuration } from "../../main/pco-timer";

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


/* ── Home's cards, extracted so a layout object and the fixed Home panel render
      THE SAME markup rather than two copies that drift. Moved verbatim: this
      changes where they live, not what they draw. ── */

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
            {todo.length === 0
              ? "everything set"
              : `${todo.length} to sort out`}
          </span>
        </header>
        {checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </section>
  );
}

export function IdlePanel({
  state,
  onlineOutputIds,
  secondsToStart,
}: {
  state: StageState;
  onlineOutputIds: readonly string[];
  /** Seconds until the next service, or null when PCO has nothing scheduled. */
  secondsToStart?: number | null;
}) {
  const checks = readinessChecks(state, onlineOutputIds);
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

  const hasHistory = overview.attPoints.length > 0 || list?.length;
  const scope = overview.scopeName ?? "services";

  return (
    <div className="flex flex-col gap-3">
      {/* Next service. The countdown is in the context bar too, but the bar is a
          glance and this is the answer to "what am I preparing for" - it names
          the plan and the series, which the bar has no room for. */}
      <NextServiceCard state={state} secondsToStart={secondsToStart} />

      <ReadinessCard checks={checks} />

      {/* Headlines only, and every one of them a way INTO History. Home restating
          History in full is how the two would drift apart; this is a glance with
          a door. Hidden entirely until something has been recorded, because a row
          of "—" teaches an operator that this panel is broken. */}
      {hasHistory ? (
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
            <Headline
              label="Start"
              value={overview.avgStart}
              sub="average"
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
