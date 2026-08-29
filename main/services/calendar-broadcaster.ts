// calendar-broadcaster.ts — the month grid, pushed instead of polled.
//
// WHY THIS EXISTS AT ALL. The first version of the calendar had every client
// refetch on a three-minute interval. That is the wrong shape for this app: a
// producer multiview can put nine calendar tiles on one wall, so nine clients
// each asked the server every three minutes for data that changes maybe twice a
// week. The house rule is change-driven broadcasts on the shared SSE channel,
// gated on demand — see integration-base.ts and service-window.ts, which carry
// the same arithmetic.
//
// So the SERVER keeps the timer — one read for the whole building, and the
// calendar client's own cache absorbs even that — and a frame goes out only when
// the grid is not what it was.
//
// THE PAYLOAD IS A MAP, keyed by view id. Two calendar views on two screens can
// filter to two different departments, so there is no single "the grid" to
// broadcast. Calendar views are counted in ones and twos, and two views with
// identical filters share a single PCO request through the client's cache.
//
// NOTHING IN THE PAYLOAD IS A PER-FETCH VALUE. No fetchedAt, no requestId, no
// duration. A timestamp that moves on every refresh makes every refresh look
// like a change, which turns broadcast-on-change back into broadcast-always
// while every test still passes.

import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import { stageController } from "./stage-controller.js";
import type { CalendarGrid } from "../types/calendar.js";

/** The SSE channel. Also listed in renderer/lib/sse-channels.ts (hydrated, because
 *  a calendar is state) and in automation-coverage.test.ts's BROADCAST_CHANNELS. */
export const CALENDAR_CHANNEL = "calendar:grid";

/**
 * How often the server re-reads Planning Center.
 *
 * Matched to the calendar client's own three-minute cache on event instances, so
 * a shorter timer would only be served the same answer. This is ONE read for the
 * building however many walls are showing it.
 */
const REFRESH_MS = 3 * 60_000;

/** What one view's read did. A view that failed keeps its last good grid. */
export interface CalendarRefreshFailure {
  viewId: string;
  message: string;
}

class CalendarBroadcaster {
  private latest: Record<string, CalendarGrid> = {};
  /** Structural signature of `latest`, for the change test below. */
  private signature = "";
  private timer: NodeJS.Timeout | null = null;

  /** Latest grids by view id — the hello burst's snapshot, so a display opened
   *  mid-month is not blank until something happens to change. */
  getLatest(): Record<string, CalendarGrid> {
    return this.latest;
  }

  /**
   * Refresh without waiting for it, reporting whatever went wrong.
   *
   * ONE implementation, called from the timer and from the settings save. Both
   * want the same thing — start a read, do not block on it, say what failed —
   * and the two hand-written copies differed only in their log line, which is
   * how the second one came to have no `.catch` on a detached promise.
   *
   * The `.catch` here is terminal, and that is not the swallow the house rule
   * forbids: refresh() already RETURNS its per-view failures, so this only ever
   * catches a rejection of the whole call — and there is no caller above a timer
   * tick to hand it to. Without it an unhandled rejection can take the process
   * down.
   */
  refreshInBackground(reason: string, force = false): void {
    void this.refresh(force)
      .then((failed) => {
        for (const f of failed) {
          console.warn(`[calendar] view ${scrub(f.viewId)} could not be refreshed (${scrub(reason)}): ${scrub(f.message)}`);
        }
      })
      .catch((err: unknown) => {
        console.error(`[calendar] refresh (${scrub(reason)}) failed outright: ${scrub(errorMessage(err))}`);
      });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.refreshInBackground("timer"), REFRESH_MS);
    // An idle timer must not hold the process open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Re-read every calendar view and broadcast only if something changed.
   *
   * @param force skip the subscriber gate. Used when an operator has just
   *   changed a view's filters: they are looking at the screen and must see it
   *   apply now, not up to three minutes later.
   * @returns the views that could not be read. NOT logged here — a partial
   *   failure belongs to the caller, which decides what to say about it.
   */
  async refresh(force = false): Promise<CalendarRefreshFailure[]> {
    // Nothing on any wall is showing a calendar, so nothing needs reading. The
    // force path is what keeps the settings picker responsive anyway.
    if (!force && !channelHasSubscribers(CALENDAR_CHANNEL)) return [];

    const views = stageController.getState().views.filter((v) => v.kind === "calendar");
    const next: Record<string, CalendarGrid> = {};
    const failed: CalendarRefreshFailure[] = [];

    for (const view of views) {
      try {
        next[view.id] = await stageController.getCalendarGrid(view.id);
      } catch (err) {
        // One view failing must not blank the others, and must not blank ITSELF:
        // the last good month stays in the map, exactly as the renderer keeps
        // the last good month on screen. The failure is returned, not dropped.
        const previous = this.latest[view.id];
        if (previous) next[view.id] = previous;
        failed.push({ viewId: view.id, message: errorMessage(err) });
      }
    }

    // A structural signature, NOT the shallow key compare StatusIntegration uses.
    // Shallow is right for a flat status DTO and wrong here: `days` is a fresh
    // array on every build, so a shallow compare would see a new reference every
    // time and broadcast every refresh — the same broadcast-always failure a
    // per-fetch timestamp causes, arrived at from the other direction.
    const signature = JSON.stringify(next);
    this.latest = next;
    if (signature === this.signature) return failed;
    this.signature = signature;
    // The signature IS the serialized payload, so it is handed straight to the
    // fan-out rather than stringified a second time — broadcast's third
    // parameter exists for exactly this, and this is a perf change.
    broadcast(CALENDAR_CHANNEL, next, signature);
    return failed;
  }
}

export const calendarBroadcaster = new CalendarBroadcaster();
