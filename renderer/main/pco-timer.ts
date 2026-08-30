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

/**
 * The instant the service is projected to end, in epoch ms — or null when there
 * is no honest answer.
 *
 * The arithmetic is the pacing widget's, rearranged. Pacing says how far the
 * clock has slipped against the plan; this says where that slippage lands. Both
 * reduce to the same thing:
 *
 *   end = (when the live item was due to finish) + (every planned length after it)
 *
 * anchored forward to `serverNow` once the live item is past its planned end, so
 * an item that keeps running pushes the projection out in real time. Written that
 * way rather than as `now + remaining` on purpose: while an item runs INSIDE its
 * plan the answer is a constant, and a constant does not flicker between 11:32
 * and 11:33 on a wall.
 *
 * WHEN THERE IS NO ANSWER — each returns null rather than a confident wrong time:
 *
 *  - No live item. Idle, pre-service, or between services: PCO is not saying
 *    where in the plan we are, so there is no "rest of the plan" to add up.
 *  - The service is over (`serviceEnded`, PCO's own SERVICE END marker).
 *  - The plan rundown has not loaded, or the live item is not in it — a plan
 *    swapped underneath us, or an item deleted mid-service.
 *  - The live item has no planned length. This is the one worth stating: without
 *    it we do not know when the CURRENT item ends, so no later item's start is
 *    known either. Adding up the remaining items alone would quietly report the
 *    end of a service whose clock has not started.
 *
 * A LATER item with no length contributes 0, matching ScriptView's projected
 * clock column — a half-filled-in plan reads early rather than blank.
 *
 * Items PCO marks `service_position: "post"` are left out. The question is when
 * the SERVICE ends, and post-service music is not part of it. A plan that marks
 * nothing includes whatever trails it, which is the best it can do.
 */
export function projectedServiceEndMs(
  pcoLive: PcoLiveDTO | null,
  planItems: PlanItemsDTO | null,
  serverNow: number,
): number | null {
  if (!pcoLive || pcoLive.mode !== "item" || !pcoLive.currentItemId || !pcoLive.liveStartAt) return null;
  if (pcoLive.serviceEnded === true) return null;

  const items = planItems?.items;
  if (!items || items.length === 0) return null;
  const idx = items.findIndex((it) => it.id === pcoLive.currentItemId);
  if (idx < 0) return null;

  const startMs = Date.parse(pcoLive.liveStartAt);
  if (!Number.isFinite(startMs)) return null;

  // The plan's own length first, PCO Live's copy as the fallback: a rundown
  // fetched before someone typed the length in still carries the old value.
  const current = items[idx].lengthSec > 0 ? items[idx].lengthSec : pcoLive.lengthSec ?? 0;
  if (!(current > 0)) return null;

  let restSec = 0;
  for (let i = idx + 1; i < items.length; i++) {
    const it = items[i];
    if (it.servicePosition === "post") continue;
    if (it.lengthSec > 0) restSec += it.lengthSec;
  }

  return Math.max(startMs + current * 1000, serverNow) + restSec * 1000;
}
