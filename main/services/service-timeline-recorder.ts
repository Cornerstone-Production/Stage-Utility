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
// debounced write, forget() — lives in ServiceRecorder, shared with the SPL and
// attendance recorders. Only the item timing below is specific to this one.

import type { PcoLiveDTO, ServiceTimeline } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { shouldRecordLive } from "./live-service-gate.js";
import { ServiceRecorder, type NewRecordContext, type RecorderStore } from "./service-recorder.js";

class ServiceTimelineRecorder extends ServiceRecorder<ServiceTimeline> {
  protected readonly label = "service-timeline-recorder";
  protected readonly store: RecorderStore<ServiceTimeline> = serviceTimelineStore;
  protected readonly persistDebounceMs = 4000;

  private lastItemId: string | null = null;
  private nextSequence = 0;

  protected createRecord(ctx: NewRecordContext): ServiceTimeline {
    return { ...ctx, endedAt: null, items: [] };
  }

  protected override onRecordEstablished(): void {
    // Continue the stored sequence rather than restarting it — a resumed record
    // would otherwise reissue numbers already in use.
    this.nextSequence = (this.current?.items ?? []).reduce((m, it) => Math.max(m, it.sequence), -1) + 1;
    this.lastItemId = null; // re-detect the live item on the next tick
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

  /** Close every open item, then let the base stamp the record's end once. */
  protected override finalizeRecord(): void {
    if (this.current) {
      const endMs = Date.now();
      const iso = new Date(endMs).toISOString();
      for (const it of this.current.items) {
        if (!it.endedAt) {
          it.endedAt = iso;
          const startMs = Date.parse(it.startedAt);
          it.actualDurationSec = Number.isFinite(startMs) ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;
        }
      }
    }
    super.finalizeRecord();
  }
}

export const serviceTimelineRecorder = new ServiceTimelineRecorder();
