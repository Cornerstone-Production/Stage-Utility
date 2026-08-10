// service-window.ts — Time-aware reconnect cadence for integrations.
//
// Church gear (ProPresenter, OBS, Smaart, wireless) is off most of the week, so
// blindly reconnecting forever is wasted network + log noise. This shared helper
// lets every integration's retry loop ask "how long until my next attempt?" and
// answers based on PCO rehearsal/service times:
//   • ACTIVE  — within [nextRehearsal − lead, lastServiceEnd + tail] (or a client is
//               actively viewing the integration): normal fast back-off (≤2 min) so
//               gear is picked up promptly as it powers on.
//   • DORMANT — otherwise: back off toward a long ceiling, and bias the next attempt
//               toward the moment the next window opens.
// The exponential ramp still runs first, so a simple mid-week restart reconnects
// within a couple minutes before it ever goes dormant.

import { clamp } from "./clamp.js";
import type { ReconnectSchedule } from "../types/stage.js";

const ACTIVE_CAP_MS = 120_000; // 2 min — the busy-window / demand ceiling

export const DEFAULT_RECONNECT_SCHEDULE: ReconnectSchedule = {
  enabled: true,
  leadMin: 120,
  tailMin: 60,
  dormantMin: 30,
};

class ServiceWindowService {
  private sched: ReconnectSchedule = { ...DEFAULT_RECONNECT_SCHEDULE };
  /** Upcoming (or current) windows in epoch ms, sorted by open. */
  private windows: { open: number; close: number }[] = [];

  setSchedule(sched: ReconnectSchedule): void {
    this.sched = sched;
  }

  /** Replace the known windows (controller recomputes from PCO periodically). */
  setWindows(windows: { open: number; close: number }[]): void {
    this.windows = [...windows].sort((a, b) => a.open - b.open);
  }

  isActive(now = Date.now()): boolean {
    return this.windows.some((w) => now >= w.open && now <= w.close);
  }

  /** ms until the next window opens (0 if inside one, Infinity if none known). */
  msUntilNextOpen(now = Date.now()): number {
    if (this.isActive(now)) return 0;
    let best = Infinity;
    for (const w of this.windows) {
      if (w.open > now) best = Math.min(best, w.open - now);
    }
    return best;
  }

  /**
   * Clamp an integration's already-computed exponential retry delay to the
   * window-aware ceiling. `forceActive` lets an integration stay snappy while a
   * client is actively watching it (demand-driven), regardless of the schedule.
   *   • feature off → plain 2-min cap (previous behavior)
   *   • active window / forced → ≤2 min (fast pickup as gear powers on)
   *   • dormant → up to the idle ceiling, but never past the next window opening
   */
  capDelayMs(rawMs: number, forceActive = false): number {
    if (!this.sched.enabled) return Math.min(rawMs, ACTIVE_CAP_MS);
    const active = forceActive || this.isActive();
    const cap = active
      ? ACTIVE_CAP_MS
      : Math.min(this.sched.dormantMin * 60_000, this.msUntilNextOpen());
    return clamp(rawMs, 1000, cap); // floor at 1s
  }

  /**
   * How long a *poller* should wait before its next tick.
   *
   * The inverse of `capDelayMs`: that one clamps a retry that has already grown,
   * this one stretches a steady cadence when nothing is happening. The PCO live
   * poll runs at 4s around the clock, which is ~151,000 requests a week against a
   * rate-limited cloud API for the ~5% of it that is a service.
   *
   * Fails OPEN. With no windows known — no PCO credentials, a failed fetch, the
   * feature switched off — this returns the active cadence, because going quiet
   * because we could not work out the schedule is how a service gets missed.
   */
  pollDelayMs(activeMs: number, dormantCeilingMs = 5 * 60_000, now = Date.now()): number {
    if (!this.sched.enabled) return activeMs;
    if (this.windows.length === 0) return activeMs; // schedule unknown → stay awake
    if (this.isActive(now)) return activeMs;
    // Never sleep past the moment the next window opens, so the ramp-up is not
    // missed by up to a whole dormant interval.
    const untilOpen = this.msUntilNextOpen(now);
    return clamp(untilOpen, activeMs, dormantCeilingMs);
  }
}

export const serviceWindow = new ServiceWindowService();
