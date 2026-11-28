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
// With no window still to come — no PCO credentials, a fetch that failed, nothing
// planned — the schedule is unknown, and both answers fail open to ACTIVE.
// The exponential ramp still runs first, so a simple mid-week restart reconnects
// within a couple minutes before it ever goes dormant.

import { clamp } from "./clamp.js";
import type { ReconnectSchedule } from "../types/stage.js";

const ACTIVE_CAP_MS = 120_000; // 2 min — the busy-window / demand ceiling

/**
 * The longest a window, or a run of overlapping ones, may hold. A Thursday rehearsal
 * through Sunday's last service is about three days; nothing real is longer. Past
 * it the plan times are taken as wrong and the window is cut, said once: what waits
 * out a window (the scheduled auto-update, the Mac helpers' updates, the page
 * deploy) would otherwise wait for as long as the bad times said.
 *
 * Cut from the CLOSE backward: the last four days are kept and the early part goes.
 * The end of a window is the service; its start is the earliest rehearsal's lead. A
 * Tuesday rehearsal before a Sunday service is a real window of about 117 h, and cut
 * from its open it ended on Saturday, so the scheduled restart at 09:00 on Sunday
 * went ahead an hour before the service.
 */
export const MAX_WINDOW_MS = 4 * 24 * 60 * 60_000;

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
  /** Whether the last answer failed open, so the log says so once per change. */
  private failingOpen: boolean | null = null;
  /** Whether the windows are known: set once a computation of them has succeeded,
   *  cleared when one fails. False from boot until the first. */
  private known = false;

  setSchedule(sched: ReconnectSchedule): void {
    this.sched = sched;
  }

  /** Replace the known windows (controller recomputes from PCO periodically). */
  setWindows(windows: { open: number; close: number }[]): void {
    this.windows = windows
      .map((w) => {
        if (w.close - w.open <= MAX_WINDOW_MS) return w;
        const kept = w.close - MAX_WINDOW_MS;
        this.sayCut(
          `window:${w.open}:${w.close}`,
          `a service window from ${new Date(w.open).toISOString()} to ${new Date(w.close).toISOString()} runs ${Math.round((w.close - w.open) / 3_600_000)} h, longer than ${MAX_WINDOW_MS / 3_600_000} h: its first ${Math.round((kept - w.open) / 3_600_000)} h, to ${new Date(kept).toISOString()}, are dropped and its last ${MAX_WINDOW_MS / 3_600_000} h kept (a plan's times may be wrong)`,
        );
        return { open: kept, close: w.close };
      })
      .sort((a, b) => a.open - b.open);
    this.known = true;
  }

  /** What has been cut and said, so a cut repeated at every refresh or read is said once. */
  private cutSaid = new Set<string>();
  private sayCut(key: string, line: string): void {
    if (this.cutSaid.has(key)) return;
    if (this.cutSaid.size > 64) this.cutSaid.clear();
    this.cutSaid.add(key);
    console.warn(`[reconnect] ${line}`);
  }

  /** The last computation failed (Planning Center could not be read): the windows
   *  kept are a guess, and whatever must not act blind treats them as unknown. */
  markUnknown(): void {
    this.known = false;
  }

  /** Whether the windows are what Planning Center last said, rather than not yet
   *  read or left from before a failure. An empty list can be known: nothing
   *  planned, or no Planning Center at all. */
  isKnown(): boolean {
    return this.known;
  }

  /**
   * Is the schedule unknown? True with no window still to come: none were ever
   * fetched (no PCO credentials, a first fetch that failed), or every one has
   * closed because each fetch since has failed or nothing is planned. Going
   * quiet on a schedule nobody could work out is how gear at an event Planning
   * Center does not know about stops being retried.
   */
  private scheduleUnknown(now: number): boolean {
    const unknown = !this.windows.some((w) => w.close >= now);
    if (unknown !== this.failingOpen) {
      if (unknown) console.log("[reconnect] no upcoming service window is known, so reconnects and polls stay at full speed");
      else if (this.failingOpen) console.log("[reconnect] service windows are known again, so reconnects back off outside them");
      this.failingOpen = unknown;
    }
    return unknown;
  }

  isActive(now = Date.now()): boolean {
    return this.windows.some((w) => now >= w.open && now <= w.close);
  }

  /** When the window open now closes, or null outside one. Windows can overlap (a
   *  rehearsal's tail running into the service's lead), so a run of overlapping
   *  ones reads as one. One pass: the windows are sorted by when they open, so any
   *  window that extends the run comes after the one it extends. */
  activeUntil(now = Date.now()): number | null {
    // Runs of overlapping windows, from their first window's open: sorted by open, so one pass finds them.
    let runOpen = 0;
    let runClose = -Infinity;
    for (const w of this.windows) {
      if (w.open <= runClose) {
        runClose = Math.max(runClose, w.close);
        continue;
      }
      if (now >= runOpen && now <= runClose) break; // the run holding now is complete
      runOpen = w.open;
      runClose = w.close;
    }
    if (!(now >= runOpen && now <= runClose)) return null;
    // A run of overlapping windows is held to the same ceiling as one, measured back from its last close: chained,
    // they could hold anything for good, and the end of the run is the service it leads up to.
    if (runClose - runOpen > MAX_WINDOW_MS) {
      const kept = runClose - MAX_WINDOW_MS;
      this.sayCut(
        `run:${runOpen}:${runClose}`,
        `service windows from ${new Date(runOpen).toISOString()} to ${new Date(runClose).toISOString()} overlap into a run longer than ${MAX_WINDOW_MS / 3_600_000} h: its first ${Math.round((kept - runOpen) / 3_600_000)} h, to ${new Date(kept).toISOString()}, are dropped and its last ${MAX_WINDOW_MS / 3_600_000} h kept`,
      );
      // Before what is kept, the run holds nothing.
      return now >= kept ? runClose : null;
    }
    return runClose;
  }

  /**
   * Is it between service windows, with the schedule known? The question a background
   * reader asks to slow down: false inside a window, and false whenever the schedule is
   * unknown or the feature is off, because going quiet on a schedule nobody could work
   * out is how a service gets missed. The same answer `pollDelayMs` stretches by.
   */
  isDormant(now = Date.now()): boolean {
    return this.sched.enabled && !this.scheduleUnknown(now) && !this.isActive(now);
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
   *   • active window / forced / schedule unknown → ≤2 min (fast pickup as gear
   *     powers on)
   *   • dormant → up to the idle ceiling, but never past the next window opening
   */
  capDelayMs(rawMs: number, forceActive = false, now = Date.now()): number {
    if (!this.sched.enabled) return Math.min(rawMs, ACTIVE_CAP_MS);
    const active = forceActive || this.scheduleUnknown(now) || this.isActive(now);
    const cap = active
      ? ACTIVE_CAP_MS
      : Math.min(this.sched.dormantMin * 60_000, this.msUntilNextOpen(now));
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
   * Fails OPEN. With the schedule unknown (see scheduleUnknown) or the feature
   * switched off, this returns the active cadence, because going quiet because
   * we could not work out the schedule is how a service gets missed.
   */
  pollDelayMs(activeMs: number, dormantCeilingMs = 5 * 60_000, now = Date.now()): number {
    if (!this.isDormant(now)) return activeMs;
    // Never sleep past the moment the next window opens, so the ramp-up is not
    // missed by up to a whole dormant interval.
    const untilOpen = this.msUntilNextOpen(now);
    return clamp(untilOpen, activeMs, dormantCeilingMs);
  }
}

export const serviceWindow = new ServiceWindowService();
