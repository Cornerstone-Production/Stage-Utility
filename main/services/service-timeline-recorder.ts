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
import { isLiveServiceToday } from "./spl-recorder.js";
import { stageController } from "./stage-controller.js";

const PERSIST_DEBOUNCE_MS = 4000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class ServiceTimelineRecorder {
  private current: ServiceTimeline | null = null;
  private currentKey: string | null = null;
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
      if (live.mode === "item" && live.currentItemId && isLiveServiceToday(live)) {
        await this.ensureRecord(live);
        if (!this.current) return;
        // Only mutate on an item transition — between transitions nothing changes.
        if (live.currentItemId !== this.lastItemId) {
          this.finalizePrevItem(); // close the OUTGOING item (this.lastItemId)
          this.lastItemId = live.currentItemId;
          this.openItem(live); // create/reopen the now-current item
          broadcast("service-timeline:history", this.current);
          this.schedulePersist();
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async ensureRecord(live: PcoLiveDTO): Promise<void> {
    const st = stageController.getState();
    if (!st.serviceTypeId || !st.planId) return;
    const date = todayLocal();
    const serviceTimeId = live.serviceTimeId;
    const key = `${st.serviceTypeId}:${st.planId}:${serviceTimeId ?? date}`;
    if (this.currentKey === key && this.current) return;

    // Tolerate a transient null serviceTimeId (cache miss) — keep the open record
    // if it's the same plan + date, so we don't split mid-service.
    if (
      serviceTimeId == null &&
      this.current &&
      this.current.serviceTypeId === st.serviceTypeId &&
      this.current.planId === st.planId &&
      this.current.serviceDate === date
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
        void serviceTimelineStore.upsert(this.current);
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}

export const serviceTimelineRecorder = new ServiceTimelineRecorder();
