// Shared PCO timer logic for the dashboard + stage display. Mirrors PCO's green
// timer: ALWAYS counts down — to the service start before service ("preservice"),
// then each item's length while live ("item"). Goes negative (counts past 0) when
// an item runs over, exactly like PCO. Nothing ever counts up.

export interface PcoTimer {
  mode: "item" | "preservice";
  /** Item title, or "Service starts". */
  label: string | null;
  /** Seconds remaining; negative when over (item) or once the start passes. When
   *  `countUp`, this is elapsed seconds (positive, increasing) instead. */
  seconds: number;
  over: boolean;
  /** True for a live item with no known length — `seconds` counts UP (elapsed). */
  countUp: boolean;
}

/** Compute the live countdown. Returns null when there's nothing to count down. */
export function computePcoTimer(
  pcoLive: PcoLiveDTO | null,
  now: number,
  skewMs: number,
): PcoTimer | null {
  if (!pcoLive || pcoLive.mode === "none") return null;
  const serverNow = now + skewMs;

  if (pcoLive.mode === "item") {
    if (!pcoLive.liveStartAt) return null;
    const elapsed = (serverNow - Date.parse(pcoLive.liveStartAt)) / 1000;
    if (pcoLive.lengthSec == null || pcoLive.lengthSec <= 0) {
      // Live item with no set length (e.g. a pre-service item) — count UP elapsed so
      // it still reads as live instead of reverting to the service-start countdown.
      return { mode: "item", label: pcoLive.label, seconds: elapsed, over: false, countUp: true };
    }
    const remaining = pcoLive.lengthSec - elapsed;
    return { mode: "item", label: pcoLive.label, seconds: remaining, over: remaining < 0, countUp: false };
  }

  // preservice
  if (!pcoLive.targetAt) return null;
  const remaining = (Date.parse(pcoLive.targetAt) - serverNow) / 1000;
  return {
    mode: "preservice",
    label: pcoLive.label ?? "Service starts",
    seconds: remaining,
    over: remaining < 0,
    countUp: false,
  };
}

// Format a duration. Days for long pre-service waits ("6d 2h"), h:mm:ss past an
// hour, else mm:ss. Negative → leading "−" (e.g. an item run over).
export function fmtDuration(totalSec: number): string {
  const neg = totalSec < 0;
  const s = Math.abs(Math.round(totalSec));
  const days = Math.floor(s / 86400);
  if (days >= 1) {
    const h = Math.floor((s % 86400) / 3600);
    return `${neg ? "−" : ""}${days}d ${h}h`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const body =
    h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  return neg ? `−${body}` : body;
}
