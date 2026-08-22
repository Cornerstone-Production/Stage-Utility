// signage-scheduler.ts — recompute the horizon, and push it only when it changed.
//
// The horizon is what makes this cheap. Because a display switches itself at a
// boundary, the server does not have to say anything between config edits: it
// arms ONE timeout at the next instant any window could change its answer, and
// otherwise sleeps. A safety tick catches whatever changed outside this module.
//
// Nothing here talks unless the map actually differs, and nothing here even
// computes when no client is subscribed — the efficiency-first rule for anything
// new on this server.

import type { SignageHorizon } from "../types/signage.js";
import { appTimeZone } from "./app-timezone.js";
import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { errorMessage } from "./errors.js";
import { HORIZON_MS, resolveSignage } from "./signage-resolve.js";
import { signageGroupsStore } from "./signage-groups-store.js";
import { signageMediaStore } from "./signage-media-store.js";
import { signageOverridesStore } from "./signage-overrides-store.js";
import { signagePlaylistsStore } from "./signage-playlists-store.js";
import { signageSchedulesStore } from "./signage-schedules-store.js";

export const SIGNAGE_PLAN_CHANNEL = "signage:plan";

/**
 * The longest the scheduler will sleep.
 *
 * PCO windows and the live state change outside this module, so a horizon whose
 * own next boundary is hours away still has to be re-checked. A minute of
 * staleness is invisible; an afternoon of it is a wall showing the wrong thing.
 */
export const SAFETY_TICK_MS = 60_000;

export type HorizonMap = Record<string, SignageHorizon>;

/**
 * Has anything actually changed?
 *
 * Structural, not by reference: every recompute builds a fresh map, so a
 * reference check would broadcast on every tick forever. JSON comparison is fine
 * at this size (a handful of outputs) and cannot miss a field the way a
 * hand-written comparison drifts into doing.
 */
export function shouldBroadcast(previous: HorizonMap | null, next: HorizonMap): boolean {
  if (!previous) return true;
  return JSON.stringify(previous) !== JSON.stringify(next);
}

/**
 * How long until the scheduler should look again.
 *
 * Always strictly positive: a boundary already in the past would arm a
 * zero-delay timer that re-arms itself immediately, which is a busy loop on a
 * Pi. Always at most SAFETY_TICK_MS.
 */
export function nextWakeMs(horizons: HorizonMap, nowMs: number): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const horizon of Object.values(horizons)) {
    for (const entry of horizon) {
      if (entry.until > nowMs && entry.until - nowMs < soonest) soonest = entry.until - nowMs;
    }
  }
  if (!Number.isFinite(soonest)) return SAFETY_TICK_MS;
  return Math.max(1, Math.min(SAFETY_TICK_MS, soonest));
}

class SignageScheduler {
  private horizons: HorizonMap = {};
  private last: HorizonMap | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** Supplied by the controller, which owns the outputs and the live state.
   *  Injected rather than imported to keep this module out of that cycle. */
  private context: (() => {
    outputs: { id: string }[];
    liveServiceTypeId: string | null;
    pcoWindows: { serviceTypeId: string; from: number; to: number; fresh: boolean }[];
  }) | null = null;

  setContext(fn: NonNullable<SignageScheduler["context"]>): void {
    this.context = fn;
  }

  /** The current map, for the hello burst and GET /api/signage/now. */
  getHorizons(): HorizonMap {
    return this.horizons;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.recompute();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Rebuild the map and push it if it changed.
   *
   * Never throws: it runs from a timer and from every store write, and an
   * exception escaping either would take the scheduler down silently. The
   * failure is logged and the previous horizon is left in place, which keeps
   * walls playing rather than blanking them over a transient read error.
   */
  async recompute(): Promise<void> {
    try {
      const ctx = this.context?.() ?? { outputs: [], liveServiceTypeId: null, pcoWindows: [] };
      const [groups, schedules, playlists, media, overrides] = await Promise.all([
        signageGroupsStore.load(),
        signageSchedulesStore.load(),
        signagePlaylistsStore.load(),
        signageMediaStore.load(),
        signageOverridesStore.load(),
      ]);

      const next = resolveSignage({
        now: Date.now(),
        tz: appTimeZone(),
        outputs: ctx.outputs as never,
        groups,
        schedules,
        playlists,
        media,
        overrides,
        pcoWindows: ctx.pcoWindows,
        liveServiceTypeId: ctx.liveServiceTypeId,
      });

      this.horizons = next;
      if (shouldBroadcast(this.last, next) && channelHasSubscribers(SIGNAGE_PLAN_CHANNEL)) {
        this.last = next;
        broadcast(SIGNAGE_PLAN_CHANNEL, next);
      } else if (shouldBroadcast(this.last, next)) {
        // Nobody is listening, so nothing was sent — but the map DID change, and
        // recording it as sent would mean the next subscriber's first real change
        // never arrives. The hello burst covers them instead.
        this.last = null;
      }
    } catch (err) {
      console.error("[signage] could not recompute the horizon:", errorMessage(err));
    } finally {
      this.arm();
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) return;
    const delay = nextWakeMs(this.horizons, Date.now());
    this.timer = setTimeout(() => void this.recompute(), delay);
    // Do not hold the process open for a signage boundary.
    this.timer.unref?.();
  }
}

export const signageScheduler = new SignageScheduler();

/** How far ahead the pushed horizon reaches. Re-exported so callers do not have
 *  to know which module owns the number. */
export { HORIZON_MS };
