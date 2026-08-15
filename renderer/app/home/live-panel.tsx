// Home, while a service is running.
//
// The timer and the current item own the screen; everything else is a glance.
// The timer maths is NOT reimplemented here — computePcoTimer already mirrors
// PCO's semantics and fmtDuration already formats it. The dashboard, the stage
// display and the context bar all use that pair; a fourth copy would be a
// fourth place for the same bug.

import { Link } from "@tanstack/react-router";
import { computePcoTimer, fmtDuration } from "../../main/pco-timer";
import { useObsState } from "../../main/use-obs-state";
import { useReaperState } from "../../main/use-reaper-state";
import { useSplState } from "../../main/use-spl-state";
import { cn } from "../../lib/cn";

/** Is anything actually recording, and what should it say?
 *
 *  Two recorders, either of which counts. They are reported TOGETHER because the
 *  question mid-service is "are we getting this?", not "what is OBS doing" - and
 *  a panel that showed only one would read as reassurance while the other sat
 *  stopped. Disconnected is not the same as not recording, and says so. */
export function recordingStat(
  obs: { connected: boolean; recording: boolean; recordTimecode: string | null } | null,
  reaper: { connected: boolean; recording: boolean } | null,
): { value: string; sub: string; tone?: "danger" | "live" } {
  const wired = [obs?.connected && "OBS", reaper?.connected && "REAPER"].filter(Boolean) as string[];
  if (wired.length === 0) return { value: "—", sub: "no recorder connected" };

  const rolling = [obs?.recording && "OBS", reaper?.recording && "REAPER"].filter(Boolean) as string[];
  if (rolling.length === 0) {
    // Connected but not rolling, mid-service, is worth noticing.
    return { value: "stopped", sub: `${wired.join(" + ")} connected`, tone: "danger" };
  }
  return {
    value: obs?.recordTimecode ?? "recording",
    sub: rolling.join(" + "),
    tone: "live",
  };
}

/** The loudest current SPL reading across every meter, which is the number
 *  anyone glancing at Home actually wants. Prefers Smaart's A-weighted slow
 *  metric and falls back to whatever the meter reports, since the metric names
 *  come from Smaart verbatim and vary by configuration. */
export function loudestSpl(spl: { connected: boolean; meters: Record<string, { metrics: Record<string, number> }> } | null): { value: string; sub: string } {
  if (!spl?.connected) return { value: "—", sub: "Smaart offline" };
  let best: number | null = null;
  let bestName = "";
  for (const [key, meter] of Object.entries(spl.meters ?? {})) {
    const entries = Object.entries(meter.metrics ?? {});
    if (!entries.length) continue;
    const preferred = entries.find(([k]) => /SPL\s*A/i.test(k)) ?? entries[0];
    if (best == null || preferred[1] > best) {
      best = preferred[1];
      bestName = key.split("::").pop() ?? key;
    }
  }
  if (best == null) return { value: "—", sub: "no readings yet" };
  return { value: `${Math.round(best)} dB`, sub: bestName };
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
        {/* Recording and SPL first: mid-service they are the two things you
            cannot recover after the fact. */}
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
