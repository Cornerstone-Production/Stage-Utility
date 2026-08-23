// signage-scheduler.ts — recompute the horizon, and push it only when it changed.
//
// The horizon is what makes this cheap. Because a display switches itself at a
// boundary, the server does not have to say anything between config edits: it
// arms ONE timeout at the next instant any window could change its answer, and
// otherwise sleeps. A safety tick catches whatever changed outside this module.
//
// Nothing here talks unless the map actually differs, and with nobody subscribed
// it never talks at all — the efficiency-first rule for anything new on this
// server. It does still COMPUTE on its tick regardless, because the map is also
// what GET /api/signage/now and the hello burst answer with, and both have to be
// right for a client that has not connected yet.

import type { SignageHorizon, SignageHorizonEntry } from "../types/signage.js";
import { appTimeZone } from "./app-timezone.js";
import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { errorMessage } from "./errors.js";
import { HORIZON_MS, resolveSignage } from "./signage-resolve.js";
import { signageGroupsStore } from "./signage-groups-store.js";
import { signageMediaStore } from "./signage-media-store.js";
import { signageOverridesStore } from "./signage-overrides-store.js";
import { listPlaylists } from "./signage-playlists-store.js";
import { signageSchedulesStore } from "./signage-schedules-store.js";
import {
  pendingChanges,
  publishedOrLive,
  type SignageConfigTriple,
} from "./signage-published-store.js";

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
 * Keep a playlist's start where it was, for as long as the same thing is still
 * playing for the same reason.
 *
 * The resolver stamps every entry's `startedAt` with its own `from`, and for the
 * entry covering NOW that is the instant of the recompute. So every rebuild
 * moved it — and a display derives its position in the cycle from `startedAt`,
 * so every rebuild sent every wall back to the first graphic.
 *
 * That fired far more often than it sounds. Any config edit anywhere rebuilds
 * the whole map, so renaming a tag no screen carries restarted every screen in
 * the building; and because the moved value made the map differ from the last
 * one, the safety tick broadcast a "change" every minute forever. Reported as
 * "every time i change what group a display is in, it causes them to restart
 * their playlist" — which was the visible half of it.
 *
 * PURE, and by identity rather than by index: the entry covering an instant can
 * move position in the list when a boundary appears earlier in the day, and
 * comparing index to index would then carry a start across a genuine change of
 * content — a playlist resuming mid-way through a loop it never started.
 */
export function carryStartedAt(previous: HorizonMap | null, next: HorizonMap): HorizonMap {
  if (!previous) return next;
  const out: HorizonMap = {};
  for (const [outputId, horizon] of Object.entries(next)) {
    const before = previous[outputId];
    out[outputId] = before ? horizon.map((e) => withCarriedStart(before, e)) : horizon;
  }
  return out;
}

/**
 * The same entry, with the start AND the beginning it already had, if this is
 * the same content still playing.
 *
 * Both, and the `from` matters as much as the start. The entry covering now is
 * rebuilt with `from` set to the instant of the rebuild, so even with the start
 * carried the map differed from the last one every time — and the safety tick
 * went on broadcasting a "change" once a minute to every display, forever.
 *
 * A `from` in the past is the truthful value anyway: it is when this content
 * began, not when the server last thought about it. Everything that reads a
 * horizon tests `from <= now < until`, which a past `from` satisfies.
 */
function withCarriedStart(before: SignageHorizon, entry: SignageHorizonEntry): SignageHorizonEntry {
  if (!entry.playlist) return entry;
  const match = before.find(
    (b) =>
      b.playlist?.id === entry.playlist?.id &&
      b.reason === entry.reason &&
      b.reasonId === entry.reasonId &&
      // Overlapping, not equal: the entry covering now had its `from` moved to
      // the instant of the rebuild, so its bounds never match the old ones.
      b.from < entry.until &&
      entry.from < b.until,
  );
  if (!match?.playlist) return entry;
  return {
    ...entry,
    from: Math.min(entry.from, match.from),
    playlist: { ...entry.playlist, startedAt: match.playlist.startedAt },
  };
}

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
  /** What the walls WOULD play if the pending edits were pushed. Null when
   *  there is nothing pending. */
  private draft: HorizonMap | null = null;
  private pending = { playlists: 0, groups: 0, schedules: 0, total: 0 };
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

  /** What a push would put on the walls, or null when nothing is pending. */
  getDraftHorizons(): HorizonMap | null {
    return this.draft;
  }

  /** How much is waiting to be pushed, by kind. */
  getPending(): { playlists: number; groups: number; schedules: number; total: number } {
    return this.pending;
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
   *
   * RETURNS whether it succeeded. The timer path ignores it — that is the whole
   * point of not throwing — but six route handlers await this and then answer
   * 200, so a failed rebuild left the operator looking at a green Save while the
   * walls stayed on the previous horizon.
   */
  async recompute(): Promise<boolean> {
    try {
      const ctx = this.context?.() ?? { outputs: [], liveServiceTypeId: null, pcoWindows: [] };
      const [groups, schedules, playlists, media, overrides] = await Promise.all([
        signageGroupsStore.load(),
        signageSchedulesStore.load(),
        listPlaylists(),
        signageMediaStore.load(),
        signageOverridesStore.load(),
      ]);

      // What the WALLS run is the published snapshot, not what the editor holds.
      // Nothing an operator types reaches a screen until they push it — see
      // signage-published-store for what that does and does not gate.
      const live = { playlists, groups, schedules };
      const published = await publishedOrLive(live);
      this.pending = pendingChanges(live, published);

      const resolveWith = (config: SignageConfigTriple) =>
        resolveSignage({
          now: Date.now(),
          tz: appTimeZone(),
          outputs: ctx.outputs as never,
          groups: config.groups,
          schedules: config.schedules,
          playlists: config.playlists,
          media,
          // Overrides are NOT part of the snapshot. A take-over is the control
          // you reach for when a wall is wrong right now, and it applies to
          // whichever config is running.
          overrides,
          pcoWindows: ctx.pcoWindows,
          liveServiceTypeId: ctx.liveServiceTypeId,
        });

      const next = resolveWith(published);
      // Only worked out when there is something to preview. Resolving twice on
      // every tick for a board nobody is looking at is exactly the kind of cost
      // this server does not pay.
      this.draft = this.pending.total > 0 ? resolveWith(live) : null;

      // Content that is still playing keeps the start it already had, so a
      // rebuild does not send every wall back to its first graphic.
      const carried = carryStartedAt(this.horizons, next);
      this.horizons = carried;
      if (shouldBroadcast(this.last, carried) && channelHasSubscribers(SIGNAGE_PLAN_CHANNEL)) {
        this.last = carried;
        broadcast(SIGNAGE_PLAN_CHANNEL, carried);
      } else if (shouldBroadcast(this.last, carried)) {
        // Nobody is listening, so nothing was sent — but the map DID change, and
        // recording it as sent would mean the next subscriber's first real change
        // never arrives. The hello burst covers them instead.
        this.last = null;
      }
      return true;
    } catch (err) {
      console.error("[signage] could not recompute the horizon:", errorMessage(err));
      return false;
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
