// service-timeline-recorder.ts — Records the ACTUAL service rundown timing across
// a live service: when each plan item really went live and how long it ran, vs its
// planned length. Driven from the live-poller (the single server-side writer), so
// it never double-counts across kiosks. Unlike the SPL recorder this needs no audio
// meter — it captures timing from PCO Live alone, so it runs for every service.
//
// On each live tick it detects item transitions: the outgoing item is finalized
// (endedAt + actualDurationSec) and the incoming item opened (plannedLengthSec +
// startedAt from PCO live_start_at). Records are keyed like the SPL + attendance
// records and persisted, so a mid-service restart resumes the same record.

import type { PcoLiveDTO, ServiceTimeline } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { serviceDateKey, shouldRecordLive } from "./live-service-gate.js";
import { stageController } from "./stage-controller.js";

const PERSIST_DEBOUNCE_MS = 4000;
/** Short gap between live-item ticks = same service (hold the record through a
 *  serviceTimeId roll on overrun); a long gap = a new service occurrence. */
const SERVICE_GAP_MS = 10 * 60_000;

class ServiceTimelineRecorder {
  private current: ServiceTimeline | null = null;
  private currentKey: string | null = null;
  private lastLiveAt = 0; // last live-item tick (to detect the gap between services)
  private lastItemId: string | null = null;
  private nextSequence = 0;
  private busy = false;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Active in-progress record (for hydration), or null when nothing is recording. */
  getCurrent(): ServiceTimeline | null {
    return this.current;
  }

  /** Called by the live-poller after each pco:live broadcast. */
  async onLiveTick(live: PcoLiveDTO | null): Promise<void> {
    if (!live || this.busy) return;
    this.busy = true;
    try {
      // `currentItemId` is re-tested here purely so TypeScript narrows it; the
      // recording policy itself lives entirely in shouldRecordLive.
      const open = this.current != null && this.current.endedAt == null;
      if (live.currentItemId && !live.serviceEnded && shouldRecordLive(live, open)) {
        const gapSinceLive = this.lastLiveAt === 0 ? Infinity : Date.now() - this.lastLiveAt;
        this.lastLiveAt = Date.now();
        await this.ensureRecord(live, gapSinceLive);
        if (!this.current) return;
        if (this.current.endedAt) this.current.endedAt = null; // resumed after a lull
        // Only mutate on an item transition — between transitions nothing changes.
        if (live.currentItemId !== this.lastItemId) {
          this.finalizePrevItem(); // close the OUTGOING item (this.lastItemId)
          this.lastItemId = live.currentItemId;
          this.openItem(live); // create/reopen the now-current item
          broadcast("service-timeline:history", this.current);
          this.schedulePersist();
        }
      } else if (this.current && !this.current.endedAt) {
        // Left "item" mode — service ended or the next service's preservice began.
        // Close the open record so consumers stop showing it as live. Self-healing:
        // an item going live above reopens it.
        this.finalizeRecord();
        this.lastItemId = null;
        await serviceTimelineStore.upsert(this.current);
        broadcast("service-timeline:history", this.current);
      }
    } finally {
      this.busy = false;
    }
  }

  private async ensureRecord(live: PcoLiveDTO, gapSinceLive = Infinity): Promise<void> {
    const st = stageController.getState();
    if (!st.serviceTypeId || !st.planId) return;
    const date = serviceDateKey(live);
    const serviceTimeId = live.serviceTimeId;
    const key = `${st.serviceTypeId}:${st.planId}:${serviceTimeId ?? date}`;
    if (this.currentKey === key && this.current) return;

    // Hold the open record through a serviceTimeId change within the same live service
    // (overrun rolls pickServiceTime to the next occurrence; a null is a cache miss).
    // A short gap since the last live tick = same service → keep appending, don't
    // split. Only a long gap means a genuinely new service occurrence.
    if (
      this.current &&
      this.current.serviceTypeId === st.serviceTypeId &&
      this.current.planId === st.planId &&
      this.current.serviceDate === date &&
      (serviceTimeId == null || gapSinceLive < SERVICE_GAP_MS)
    ) {
      return;
    }

    // Key changed → finalize + persist the outgoing record.
    if (this.current) {
      this.finalizeRecord();
      await serviceTimelineStore.upsert(this.current);
    }

    // Resume an existing record for this occurrence (e.g. after a restart), else create.
    const existing = await serviceTimelineStore.get(key);
    if (existing) {
      this.current = existing;
      this.current.endedAt = null; // reopened
      this.nextSequence = existing.items.reduce((m, it) => Math.max(m, it.sequence), -1) + 1;
    } else {
      this.current = {
        serviceKey: key,
        serviceTypeId: st.serviceTypeId,
        serviceTypeName: st.serviceTypeName ?? null,
        planId: st.planId,
        planTitle: st.planTitle,
        seriesTitle: st.planSeriesTitle ?? null,
        serviceDate: date,
        serviceTimeId: serviceTimeId ?? null,
        serviceTimeStartsAt: live.serviceTimeStartsAt,
        startedAt: new Date().toISOString(),
        endedAt: null,
        items: [],
      };
      this.nextSequence = 0;
    }
    this.currentKey = key;
    this.lastItemId = null; // re-detect the live item on the next tick
  }

  /** Open (or reopen) the current item — snapshot planned length + actual start. */
  private openItem(live: PcoLiveDTO): void {
    if (!this.current || !live.currentItemId) return;
    const id = live.currentItemId;
    const title = live.label ?? live.currentItemTitle ?? "";
    const planned = typeof live.lengthSec === "number" && live.lengthSec > 0 ? live.lengthSec : null;
    const item = this.current.items.find((i) => i.itemId === id);
    if (item) {
      // Operator stepped back to an earlier item — reopen it.
      if (title) item.title = title;
      if (planned != null) item.plannedLengthSec = planned;
      item.endedAt = null;
      item.actualDurationSec = null;
      return;
    }
    this.current.items.push({
      itemId: id,
      title,
      sequence: this.nextSequence++,
      plannedLengthSec: planned,
      startedAt: live.liveStartAt ?? new Date().toISOString(),
      endedAt: null,
      actualDurationSec: null,
      preService: live.beforeServiceStart === true, // pre-service default (position-based)
    });
  }

  /** Close the outgoing item (this.lastItemId) and compute its actual duration. */
  private finalizePrevItem(): void {
    if (!this.current || !this.lastItemId) return;
    const prev = this.current.items.find((i) => i.itemId === this.lastItemId);
    if (prev && !prev.endedAt) {
      const endMs = Date.now();
      prev.endedAt = new Date(endMs).toISOString();
      const startMs = Date.parse(prev.startedAt);
      prev.actualDurationSec = Number.isFinite(startMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
    }
  }

  private finalizeRecord(): void {
    if (!this.current) return;
    const endMs = Date.now();
    const iso = new Date(endMs).toISOString();
    for (const it of this.current.items) {
      if (!it.endedAt) {
        it.endedAt = iso;
        const startMs = Date.parse(it.startedAt);
        it.actualDurationSec = Number.isFinite(startMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
      }
    }
    this.current.endedAt = iso;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty && this.current) {
        this.dirty = false;
        // Inside a timer — see attendance-recorder.schedulePersist.
        void serviceTimelineStore
          .upsert(this.current)
          .catch((err) => console.error("[service-timeline-recorder] persist failed:", err));
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}

export const serviceTimelineRecorder = new ServiceTimelineRecorder();
