// service-timeline-recorder.ts — Records the ACTUAL service rundown timing across
// a live service: when each plan item really went live and how long it ran, vs its
// planned length. Driven from the live-poller (the single server-side writer), so
// it never double-counts across kiosks. Unlike the SPL recorder this needs no audio
// meter — it captures timing from PCO Live alone, so it runs for every service.
//
// On each live tick it detects item transitions: the outgoing item is finalized
// (endedAt + actualDurationSec) and the incoming item opened (plannedLengthSec +
// startedAt from PCO live_start_at).
//
// The record lifecycle — which occurrence is open, when to start or close one, the
// debounced write, forget() — lives in ServiceRecorder, and the per-item tick it
// shares with the SPL recorder in ItemRecorder. Only the item timing below is
// specific to this one.

import type { ServiceTimeline, ServiceTimelineItem } from "../types/stage.js";
import { broadcastTimeline } from "./history-item-times.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { scrub } from "./scrub.js";
import {
  ItemRecorder,
  SERVICE_GAP_MS,
  closeTimelineItems,
  isStepBackTo,
  itemLiveSinceMs,
  lastItemEntry,
  liveItemTitle,
  plannedLengthSec,
  type LiveItemTick,
  type NewRecordContext,
  type RecorderStore,
} from "./service-recorder.js";

/** "2d 3h" past a day, "3h 12m" under one — for the carry-over log line. Not
 *  fmtDuration from renderer/main/pco-timer.ts: that one is renderer-side and
 *  formats a clock-style "H:MM:SS", which reads wrong for "how long has this
 *  been sitting live in PCO" (a duration, not a countdown). */
function fmtCarryoverDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / (24 * 60));
  if (days >= 1) return `${days}d ${Math.floor((totalMin % (24 * 60)) / 60)}h`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hours >= 1 ? `${hours}h ${mins}m` : `${mins}m`;
}

class ServiceTimelineRecorder extends ItemRecorder<ServiceTimeline> {
  protected readonly label = "service-timeline-recorder";
  protected readonly store: RecorderStore<ServiceTimeline> = serviceTimelineStore;
  protected readonly persistDebounceMs = 4000;

  protected createRecord(ctx: NewRecordContext): ServiceTimeline {
    return { ...ctx, endedAt: null, items: [] };
  }

  /** Told by ensureRecord's split and closeIfOpen — see publishClosed's doc on the base class. */
  protected override publishClosed(record: ServiceTimeline): void {
    broadcastTimeline(record);
  }

  /** Each closed run gets its length: the boot-time close uses the same closer. */
  protected closeItems(items: ServiceTimelineItem[], endIso: string): void {
    closeTimelineItems(items, endIso);
  }

  protected recordTick(live: LiveItemTick, record: ServiceTimeline): void {
    // Only mutate on an item transition — between transitions nothing changes.
    if (!this.advanceItem(live)) return; // closes the OUTGOING item
    this.openItem(live); // create/reopen the now-current item
    broadcastTimeline(record);
    this.schedulePersist();
  }

  /** Open (or reopen) the current item — snapshot planned length + actual start. */
  private openItem(live: LiveItemTick): void {
    const record = this.current;
    if (!record) return;
    const id = live.currentItemId;
    const title = liveItemTitle(live);
    const planned = plannedLengthSec(live);
    const liveStartMs = live.liveStartAt ? Date.parse(live.liveStartAt) : NaN;
    // Shared with the SPL recorder, so the two cannot answer "is this the same
    // run" differently about the same live service.
    const goingLiveAtMs = itemLiveSinceMs(live);
    // The LAST entry for this id, not the first: an item can run more than once.
    const item = lastItemEntry(record.items, id);
    if (item && isStepBackTo(item, goingLiveAtMs)) {
      // Operator stepped back to an earlier item — reopen it.
      if (title) item.title = title;
      if (planned != null) item.plannedLengthSec = planned;
      item.endedAt = null;
      item.actualDurationSec = null;
      return;
    }
    // Belt and braces for the occurrence split (see ensureRecord): an item whose
    // last run finished more than SERVICE_GAP_MS ago is a RE-RUN, and gets its own
    // entry rather than rewriting history. Without this a missed split let a second
    // service silently overwrite the first service's timings in place.
    if (item) {
      console.log(
        `[service-timeline] "${scrub(title || id)}" went live again ` +
          `${scrub(Math.round((goingLiveAtMs - Date.parse(item.endedAt!)) / 60_000))} min after its last run ended — ` +
          `recording it as a new entry`,
      );
    }
    // A NEW item whose PCO live_start_at predates this record by more than the
    // same-service gap was already live in Planning Center before this record
    // opened — a leftover from an earlier session left sitting on-air (the
    // production incident this guards: a BENEDICTION left live since Thursday
    // night adopted its two-day-old start and the pacing widget read +2d 10h).
    // Clamp its start to the record's own and mark it not counted; a real item
    // that started within the gap is unchanged.
    let startedAt = live.liveStartAt ?? new Date().toISOString();
    let counted: boolean | undefined;
    const recordStartMs = Date.parse(record.startedAt);
    if (Number.isFinite(liveStartMs) && Number.isFinite(recordStartMs) && recordStartMs - liveStartMs > SERVICE_GAP_MS) {
      const carriedMs = recordStartMs - liveStartMs;
      startedAt = record.startedAt;
      counted = false;
      console.log(
        `[service-timeline] "${scrub(title)}" had been live in Planning Center for ` +
          `${scrub(fmtCarryoverDuration(carriedMs))} before this record opened — ` +
          `carried over from an earlier session, not counted`,
      );
    }
    record.items.push({
      itemId: id,
      title,
      sequence: this.nextSequence++,
      plannedLengthSec: planned,
      startedAt,
      endedAt: null,
      actualDurationSec: null,
      preService: live.beforeServiceStart === true, // pre-service default (position-based)
      counted,
    });
  }
}

export const serviceTimelineRecorder = new ServiceTimelineRecorder();
