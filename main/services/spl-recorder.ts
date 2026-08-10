// spl-recorder.ts — Records max/avg SPL per service-plan item across a live
// service. Driven from the live-poller (the single server-side writer), so it
// never double-counts across multiple kiosk displays.
//
// On each live tick with an item in progress it samples the current SPL meter
// and folds it into that item's running max/avg. Item transitions finalize the
// prior item; a plan change / auto-advance rollover (a new serviceKey) finalizes
// the whole record. Records are keyed `${serviceTypeId}:${planId}:${YYYY-MM-DD}`
// and persisted to disk, so a mid-service restart resumes the same record.

import type { PcoLiveDTO, ServiceSplHistory, SplMetricsDTO } from "../types/stage.js";
import { rebuildSplRecord } from "./archive/rebuild.js";
import { sampleArchive } from "./archive/sample-archive.js";
import { addLeqSample } from "./spl-leq.js";
import { broadcast } from "./broadcaster.js";
import { serviceDateKey, shouldRecordLive } from "./live-service-gate.js";
import { smaartService } from "./smaart-service.js";
import { splHistoryStore } from "./spl-history-store.js";
import { stageController } from "./stage-controller.js";

// How long a change may sit in memory before it is written.
//
// This was 4s, when the debounced write was the only durability guarantee — a
// crash lost whatever had not been flushed. Every sample is now appended to the
// raw archive as it arrives, and `ensureRecord` rebuilds from it on resume, so the
// window costs nothing and the store is rewritten ~75 times per service instead of
// ~1125. The UI never waits on this: it reads the in-memory record over SSE.
const PERSIST_DEBOUNCE_MS = 60_000;
/** Max cadence for pushing the (O(n)) live record to trend viewers between item changes. */
const LIVE_BROADCAST_MS = 5_000;
/** Short gap between live-item ticks = same service (hold the record through a
 *  serviceTimeId roll on overrun); a long gap = a new service occurrence. */
const SERVICE_GAP_MS = 10 * 60_000;
/** Metric preference for the recorded level (A-weighted, slow → broadband). */
/** Metric preference order, shared with the SPL automation triggers so a rule
 *  that names no metric picks the same one the recorder does. */
export const PREFERRED_METRICS = ["SPL A Slow", "SPL A Fast", "LAeq 10", "SPL Slow", "SPL Fast"];

// Whether a live tick may be recorded lives in live-service-gate.ts — shared by
// all three recorders so they cannot drift into disagreeing about when a service
// is happening. It replaced a local-date comparison that stopped every recorder
// mid-service at midnight UTC (19:00 in Chicago).

interface MeterSample {
  meterId: string;
  /** EVERY metric the first meter reported this tick (peak, LAeq, LCeq, …). */
  metrics: Record<string, number>;
}

/** Grab the first meter's full metric set from the live SPL state. */
function pickMeter(spl: SplMetricsDTO | null): MeterSample | null {
  if (!spl || !spl.connected) return null;
  const ids = Object.keys(spl.meters);
  if (ids.length === 0) return null;
  const id = ids[0];
  const meter = spl.meters[id];
  if (!meter || Object.keys(meter.metrics).length === 0) return null;
  return { meterId: id, metrics: meter.metrics };
}

class SplRecorder {
  private current: ServiceSplHistory | null = null;
  private currentKey: string | null = null;
  private lastLiveAt = 0; // last live-item tick (to detect the gap between services)
  private lastItemId: string | null = null;
  private lastBroadcastAt = 0;
  private nextSequence = 0;
  private busy = false;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Active in-progress record (for hydration), or null when nothing is recording. */
  getCurrent(): ServiceSplHistory | null {
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
        let itemChanged = false;
        if (live.currentItemId !== this.lastItemId) {
          this.finalizePrevItem();
          this.lastItemId = live.currentItemId;
          itemChanged = true;
          if (this.currentKey) {
            sampleArchive.recordEvent(
              { serviceKey: this.currentKey, serviceDate: this.current.serviceDate },
              "pco",
              "item",
              live.label ?? live.currentItemId,
            );
          }
        }
        this.recordSample(
        live.currentItemId,
        live.label,
        live.itemType ?? null,
        pickMeter(smaartService.getLatest()),
      );
        // The record is O(n) and item max/avg move slowly — push on an item change,
        // else at most every LIVE_BROADCAST_MS instead of every tick.
        const now = Date.now();
        if (itemChanged || now - this.lastBroadcastAt >= LIVE_BROADCAST_MS) {
          this.lastBroadcastAt = now;
          broadcast("spl:history", this.current);
        }
        this.schedulePersist();
      } else if (this.current && !this.current.endedAt) {
        // Left "item" mode — the service ended (mode "none") or the next service's
        // preservice countdown began. Close the open record so the History tab stops
        // showing it as live. Self-healing: an item going live above reopens it.
        this.finalizeRecord();
        this.lastItemId = null;
        await splHistoryStore.upsert(this.current);
        broadcast("spl:history", this.current);
      }
    } finally {
      this.busy = false;
    }
  }

  private async ensureRecord(live: PcoLiveDTO, gapSinceLive = Infinity): Promise<void> {
    const st = stageController.getState();
    if (!st.serviceTypeId || !st.planId) return; // can't key a record yet
    const date = serviceDateKey(live);
    // Separate back-to-back services that share one plan by the PCO service-time
    // occurrence (9am vs 11am). Fall back to the date when no service time is known.
    const serviceTimeId = live.serviceTimeId;
    const key = `${st.serviceTypeId}:${st.planId}:${serviceTimeId ?? date}`;
    if (this.currentKey === key && this.current) return;

    // Hold the open record through a serviceTimeId change within the same live
    // service: pickServiceTime rolls to the NEXT occurrence when a service runs past
    // its planned end (and a null is a transient cache miss). A short gap since the
    // last live tick = same service → keep appending, don't split; only a long gap
    // means a genuinely new occurrence.
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
      await splHistoryStore.upsert(this.current);
    }

    // Resume an existing record for this occurrence (e.g. after a restart), else create.
    const existing = await splHistoryStore.get(key);
    if (existing) {
      // A restart loses everything since the last debounced write. The raw layer
      // has every sample that arrived, so rebuild the aggregates from it rather
      // than resuming a record that is short by up to PERSIST_DEBOUNCE_MS. Returns
      // null for a service recorded before the archive existed — then the stored
      // record is all there is, which is the old behaviour.
      const rebuilt = await rebuildSplRecord(existing).catch(() => null);
      if (rebuilt) console.log(`[spl-recorder] rebuilt ${key} from the archive on resume`);
      this.current = rebuilt ?? existing;
      this.current.endedAt = null; // reopened
      // From the resumed record, not `existing`: a rebuild can hold items the
      // stored copy never got, and seeding from the short list would reissue
      // sequences that are already in use.
      this.nextSequence = this.current.items.reduce((m, it) => Math.max(m, it.sequence), -1) + 1;
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
        meterId: null,
        metricKey: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        items: [],
      };
      this.nextSequence = 0;
    }
    this.currentKey = key;
    this.lastItemId = null; // re-detect the live item on the next sample
  }

  private recordSample(
    itemId: string,
    title: string | null,
    itemType: string | null,
    sample: MeterSample | null,
  ): void {
    if (!this.current) return;
    let item = this.current.items.find((i) => i.itemId === itemId);
    if (!item) {
      item = {
        itemId,
        title: title ?? "",
        itemType,
        sequence: this.nextSequence++,
        metrics: {},
        maxSpl: null,
        sampleCount: 0,
        startedAt: new Date().toISOString(),
        endedAt: null,
      };
      this.current.items.push(item);
    } else {
      if (title && item.title !== title) item.title = title;
      // The plan may not have been loaded when the item first went live.
      if (itemType && item.itemType !== itemType) item.itemType = itemType;
    }
    if (!item.metrics) item.metrics = {}; // resumed legacy record

    if (sample) {
      if (this.current.meterId == null) {
        this.current.meterId = sample.meterId;
        this.current.metricKey =
          PREFERRED_METRICS.find((k) => k in sample.metrics) ?? Object.keys(sample.metrics)[0] ?? null;
      }
      // Fold EVERY reported metric into its own running max + Leq. The mean is
      // energy-weighted (see spl-leq.ts): a plain average of decibels understates
      // a dynamic item badly, and for LAeq/LCeq it would be an average of averages.
      for (const [key, v] of Object.entries(sample.metrics)) {
        let st = item.metrics[key];
        if (!st) {
          st = { max: null, avg: null, leq: null, count: 0 };
          item.metrics[key] = st;
        }
        st.max = st.max == null ? v : Math.max(st.max, v);
        st.leq = addLeqSample(st.leq ?? null, st.count, v);
        st.count += 1;
      }
      // Keep the raw readings too. The fold above is lossy by design — max/leq/count
      // cannot be un-averaged — which is why the corrected Leq could not be applied
      // to anything already recorded. See docs/data-archive.md.
      if (this.currentKey) {
        sampleArchive.recordSpl(
          { serviceKey: this.currentKey, serviceDate: this.current.serviceDate },
          itemId,
          item.title,
          sample.metrics,
        );
      }
      // Keep the legacy single-metric fields populated (primary metric) for back-compat.
      const pk = this.current.metricKey;
      if (pk && pk in sample.metrics) {
        const v = sample.metrics[pk];
        item.maxSpl = item.maxSpl == null ? v : Math.max(item.maxSpl, v);
        item.leqSpl = addLeqSample(item.leqSpl ?? null, item.sampleCount, v);
        item.sampleCount += 1;
      }
    }
  }

  private finalizePrevItem(): void {
    if (!this.current || !this.lastItemId) return;
    const prev = this.current.items.find((i) => i.itemId === this.lastItemId);
    if (prev && !prev.endedAt) prev.endedAt = new Date().toISOString();
  }

  private finalizeRecord(): void {
    if (!this.current) return;
    const now = new Date().toISOString();
    for (const it of this.current.items) if (!it.endedAt) it.endedAt = now;
    // Stamp once — see service-timeline-recorder.finalizeRecord. Re-finalizing on
    // a key change would rewrite the outgoing service's end to the moment the next
    // one began.
    if (!this.current.endedAt) this.current.endedAt = now;
    // The record is closed: name what the raw layer captured, then release the
    // appenders. A later item going live reopens the record and the files resume.
    const ctx = { serviceKey: this.current.serviceKey, serviceDate: this.current.serviceDate };
    void sampleArchive
      .writeManifest(ctx)
      .then(() => sampleArchive.closeService(ctx.serviceKey))
      .catch((err) => console.error("[spl-recorder] archive close failed:", err));
  }

  /**
   * Drop an in-memory record so a delete of it is not undone.
   *
   * Deleting a record removed the file and the store's cache entry, but this
   * recorder still held `current`/`currentKey`; ensureRecord short-circuits on a
   * matching key, kept appending, and the debounced persist recreated the file
   * seconds later. The row reappeared on the next refresh and the delete button
   * read as broken. Merging had the same shape: the source key was deleted while
   * still being recorded, so it came back with its items now duplicated across
   * both records.
   *
   * Cancels the pending write too — otherwise the timer that is already queued
   * puts the record straight back.
   */
  forget(serviceKey: string): boolean {
    if (this.currentKey !== serviceKey && this.current?.serviceKey !== serviceKey) return false;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.dirty = false;
    this.current = null;
    this.currentKey = null;
    return true;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty && this.current) {
        this.dirty = false;
        // Inside a timer — see attendance-recorder.schedulePersist.
        void splHistoryStore
          .upsert(this.current)
          .catch((err) => console.error("[spl-recorder] persist failed:", err));
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}

export const splRecorder = new SplRecorder();
