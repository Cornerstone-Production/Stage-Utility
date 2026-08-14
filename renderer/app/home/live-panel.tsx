// Home, while a service is running.
//
// The timer and the current item own the screen; everything else is a glance.
// The timer maths is NOT reimplemented here — computePcoTimer already mirrors
// PCO's semantics and fmtDuration already formats it. The dashboard, the stage
// display and the context bar all use that pair; a fourth copy would be a
// fourth place for the same bug.

import { Link } from "@tanstack/react-router";
import { computePcoTimer, fmtDuration } from "../../main/pco-timer";
import { cn } from "../../lib/cn";

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
    <Link to={to} className={cn(className, "transition-colors hover:border-line-strong")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function LivePanel({
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
        <Stat
          label="Screens"
          value={`${onlineOutputIds.length}/${outputCount}`}
          sub={onlineOutputIds.length === outputCount ? "all connected" : "one or more offline"}
          to="/screens"
          tone={onlineOutputIds.length === outputCount ? undefined : "danger"}
        />
        <Stat label="Service" value={pcoLive?.serviceTimeStartsAt ? "running" : "—"} sub="per Planning Center" />
        <Stat label="History" value="open" sub="timing and attendance" to="/history" />
      </div>
    </div>
  );
}
