// attendance-phase.ts — which part of the attendance curve is this live tick?
//
// Split out of the recorder so the decision is testable on its own. The recorder
// owns the record and the sampling; this owns only "pre / service / post / stop".
//
// Three phases, and the order they are tested in matters:
//
//   1. LATCH — a live plan item with an open record is the service proper, decided
//      by live-service-gate. The plan's own SERVICE END / SERVICE START headers
//      reclassify it to post/pre; nothing time-based may.
//
//   2. ARRIVAL RAMP — no live item, but a service is coming up within the lead
//      window. Tested BEFORE the taper on purpose: when two services are close
//      enough that the second's ramp overlaps the first's taper, the room is
//      filling for the next service, not emptying from the last.
//
//   3. TAPER — the emptying room, for `postMs` after the record closed.
//
// The taper must stay reachable from BOTH "none" and "preservice" mode. It did not
// used to be: the preservice branch ended in an unconditional `return null`, and
// PCO reports mode "preservice" whenever a service time exists and no item is live
// — which is the normal state right after a benediction. So the taper only ran on
// plans with no service time at all, and every real Sunday recorded nothing after
// the last item. The 60-minute window was configured, read, and never reached.

import type { PcoLiveDTO } from "../types/stage.js";
import { isServiceNearNow, shouldRecordLive } from "./live-service-gate.js";

export type Phase = "pre" | "service" | "post";

/**
 * How long after a service's start time the arrival ramp may still apply.
 *
 * The ramp is for a room filling before a service. A few minutes of grace past the
 * start absorbs a late start, but past that a service that has begun is either
 * running (the latch handles it) or over (the taper does).
 */
export const RAMP_GRACE_MS = 5 * 60_000;

export interface PhaseContext {
  /** This recorder holds a record that is not yet closed. */
  hasOpenRecord: boolean;
  /** `endedAt` of the record being held, if it has been closed. */
  endedAt: string | null;
  /**
   * `serviceTimeId` of the record being held.
   *
   * The taper describes a room emptying from the service that just ran, so it
   * must never be applied to the record for the service we are ramping TOWARD.
   * Without this the two are indistinguishable, and a late-starting service
   * tapered its own arrival crowd — see the header.
   */
  heldServiceTimeId: string | null;
  /** Arrival-ramp lead window (ms). 0 disables the ramp. */
  preMs: number;
  /** Post-service taper window (ms). 0 disables the taper. */
  postMs: number;
}

export function classifyPhase(
  live: PcoLiveDTO,
  ctx: PhaseContext,
  nowMs: number = Date.now(),
): Phase | null {
  // 1. The latch. An already-open record plus a live item is ALWAYS the service —
  // that is the rule from the outage, and no clock may demote it to a taper.
  if (shouldRecordLive(live, ctx.hasOpenRecord, nowMs)) {
    if (live.serviceEnded) return "post"; // parked on an item past SERVICE END
    if (live.beforeServiceStart) return "pre"; // pre-roll item above SERVICE START
    return "service";
  }

  // 2. The arrival ramp.
  if (live.mode === "preservice" && ctx.preMs > 0 && isServiceNearNow(live, nowMs)) {
    const start = live.serviceTimeStartsAt ? Date.parse(live.serviceTimeStartsAt) : NaN;
    if (Number.isFinite(start) && start - nowMs <= ctx.preMs && nowMs <= start + RAMP_GRACE_MS) {
      return "pre";
    }
    // Deliberately falls through to the taper rather than returning. See the header.
  }

  // 3. The taper — the room emptying from the service that just ran.
  //
  // The held record must be a DIFFERENT occurrence from the one PCO is currently
  // reporting. A service that starts late sits in "preservice" past the ramp
  // grace; the fall-through above then reached here, the recorder closed the
  // fresh record, and the taper immediately reopened it — so the room filling
  // for that service was recorded as its own post-service taper, before it had
  // begun. Comparing the occurrence is what separates "emptying from the last"
  // from "filling for the next".
  if (ctx.postMs > 0 && ctx.endedAt && ctx.heldServiceTimeId !== live.serviceTimeId) {
    const ended = Date.parse(ctx.endedAt);
    if (Number.isFinite(ended) && nowMs - ended <= ctx.postMs) return "post";
  }

  return null;
}
