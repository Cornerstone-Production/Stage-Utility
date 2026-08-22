// signage-pco-windows.ts — when a PCO-driven schedule is open.
//
// A `pco` window does not evaluate anything itself. This module turns Planning
// Center's plan times into concrete instants ahead of time, so the resolver stays
// pure and a horizon can be computed for the next 24 hours without a network
// call per boundary.
//
// It polls only for service types a schedule actually names, only while such a
// schedule is enabled, and every 30 minutes — plan times change rarely, and the
// PCO request budget is shared with everything else on this box.

import type { PcoWindow } from "../types/signage.js";
import { type TimeZone, appTimeZone, zonedParts } from "./app-timezone.js";
import { errorMessage } from "./errors.js";
import { pcoService } from "./pco-service.js";
import { signageSchedulesStore } from "./signage-schedules-store.js";

/** Plan times change rarely; a shorter poll would only spend request budget. */
const REFRESH_MS = 30 * 60_000;

/** "YYYY-MM-DD" for the local day containing `ms`. */
function dateKey(ms: number, tz: TimeZone): string {
  const p = zonedParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * One window from a plan's times, for one local day.
 *
 * Only `service` times count. A rehearsal counted as a start would open the
 * foyer screens two hours before anyone is in the building, and nothing on the
 * schedule row would explain why.
 *
 * Null when that day has no service times — distinct from a zero-length window,
 * which would be a window nothing can match rather than the absence of one.
 */
export function windowFromPlanTimes(
  serviceTypeId: string,
  times: { type: string; startsAt: string }[],
  leadMinutes: number,
  trailMinutes: number,
  tz: TimeZone,
  localDay: string,
): PcoWindow | null {
  const starts = times
    .filter((t) => t.type === "service")
    .map((t) => Date.parse(t.startsAt))
    // A single unparseable row must not poison the window: NaN propagates
    // through min/max and produces one nothing can match.
    .filter((ms) => Number.isFinite(ms))
    // Saturday evening and Sunday morning are different local days; merging them
    // would hold one window open all night.
    .filter((ms) => dateKey(ms, tz) === localDay);

  if (starts.length === 0) return null;

  return {
    serviceTypeId,
    from: Math.min(...starts) - leadMinutes * 60_000,
    to: Math.max(...starts) + trailMinutes * 60_000,
    fresh: true,
  };
}

/**
 * What to use after a refresh attempt.
 *
 * @param fetched the fresh windows, or NULL when the fetch failed.
 *
 * A failure keeps the previous windows and marks them stale. Failing closed
 * would mean dark foyer screens on a Sunday because an API call timed out, which
 * is a worse outcome than slightly old plan times; the staleness is surfaced in
 * the UI, which an operator can act on.
 *
 * An empty ARRAY is different from a failure: it means PCO answered and there is
 * nothing on today, so the old windows really are cleared. Holding them would
 * light the screens on a Tuesday.
 */
export function mergeKeepingLastKnown(
  previous: PcoWindow[],
  fetched: PcoWindow[] | null,
): PcoWindow[] {
  if (fetched) return fetched;
  return previous.map((w) => (w.fresh ? { ...w, fresh: false } : w));
}

class SignagePcoWindows {
  private windows: PcoWindow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  /** Supplied by the controller: PCO credentials, or null when unconfigured. */
  private creds: (() => { appId: string; secret: string } | null) | null = null;
  /** Called after a refresh that changed anything, so the scheduler recomputes. */
  private onChange: (() => void) | null = null;

  configure(o: {
    creds: () => { appId: string; secret: string } | null;
    onChange: () => void;
  }): void {
    this.creds = o.creds;
    this.onChange = o.onChange;
  }

  get(): PcoWindow[] {
    return this.windows;
  }

  /** True when the windows in hand came from cache after a failed fetch. */
  isStale(): boolean {
    return this.windows.some((w) => !w.fresh);
  }

  /** The last failure, for the UI. Null once a refresh succeeds. */
  error(): string | null {
    return this.lastError;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Re-read today's and tomorrow's windows.
   *
   * Never throws — it runs from a timer. The failure is recorded and returned
   * through error()/isStale() rather than swallowed, and the previous windows
   * stay in use.
   */
  async refresh(): Promise<void> {
    const before = JSON.stringify(this.windows);
    try {
      const schedules = await signageSchedulesStore.load();
      // Only service types an ENABLED schedule actually names. A box with no
      // PCO-driven schedule makes no requests at all.
      const wanted = [
        ...new Set(
          schedules
            .filter((s) => s.enabled && s.window.kind === "pco")
            .map((s) => (s.window as { serviceTypeId: string }).serviceTypeId)
            .filter(Boolean),
        ),
      ];
      if (wanted.length === 0) {
        this.windows = [];
        this.lastError = null;
        return;
      }

      const creds = this.creds?.();
      if (!creds) {
        // Not configured is not a failure — there is nothing to be stale about.
        this.windows = [];
        this.lastError = null;
        return;
      }

      const tz = appTimeZone();
      const now = Date.now();
      const days = [dateKey(now, tz), dateKey(now + 86_400_000, tz)];
      const fetched: PcoWindow[] = [];

      for (const serviceTypeId of wanted) {
        const plans = await pcoService.listUpcomingPlans(creds.appId, creds.secret, serviceTypeId);
        for (const plan of plans.slice(0, 4)) {
          const times = await pcoService.listPlanTimes(
            creds.appId,
            creds.secret,
            serviceTypeId,
            plan.id,
          );
          for (const day of days) {
            // Lead and trail come from the SCHEDULE, so the same plan can yield
            // different windows for two schedules with different padding.
            for (const s of schedules) {
              if (!s.enabled || s.window.kind !== "pco") continue;
              if (s.window.serviceTypeId !== serviceTypeId) continue;
              const w = windowFromPlanTimes(
                serviceTypeId,
                times,
                s.window.leadMinutes,
                s.window.trailMinutes,
                tz,
                day,
              );
              if (w) fetched.push(w);
            }
          }
        }
      }

      this.windows = mergeKeepingLastKnown(this.windows, fetched);
      this.lastError = null;
    } catch (err) {
      this.lastError = errorMessage(err);
      this.windows = mergeKeepingLastKnown(this.windows, null);
      console.error("[signage-pco] could not refresh plan windows; keeping the last known:", this.lastError);
    } finally {
      if (JSON.stringify(this.windows) !== before) this.onChange?.();
    }
  }
}

export const signagePcoWindows = new SignagePcoWindows();
