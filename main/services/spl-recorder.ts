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
import { broadcast } from "./broadcaster.js";
import { smaartService } from "./smaart-service.js";
import { splHistoryStore } from "./spl-history-store.js";
import { stageController } from "./stage-controller.js";

const PERSIST_DEBOUNCE_MS = 4000;
/** Metric preference for the recorded level (A-weighted, slow → broadband). */
const PREFERRED_METRICS = ["SPL A Slow", "SPL A Fast", "LAeq 10", "SPL Slow", "SPL Fast"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
  private lastItemId: string | null = null;
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
      if (live.mode === "item" && live.currentItemId) {
        await this.ensureRecord(live);
        if (!this.current) return;
        if (live.currentItemId !== this.lastItemId) {
          this.finalizePrevItem();
          this.lastItemId = live.currentItemId;
        }
        this.recordSample(live.currentItemId, live.label, pickMeter(smaartService.getLatest()));
        broadcast("spl:history", this.current);
        this.schedulePersist();
      }
      // Non-item modes (preservice/none) don't finalize: a plan change or
      // auto-advance rollover (a new serviceKey) closes the record in ensureRecord.
    } finally {
      this.busy = false;
    }
  }

  private async ensureRecord(live: PcoLiveDTO): Promise<void> {
    const st = stageController.getState();
    if (!st.serviceTypeId || !st.planId) return; // can't key a record yet
    const date = todayLocal();
    // Separate back-to-back services that share one plan by the PCO service-time
    // occurrence (9am vs 11am). pickServiceTime flips to the next occurrence as one
    // ends, which is exactly the boundary we want. Fall back to the date when no
    // service time is known (keeps legacy keys stable).
    const serviceTimeId = live.serviceTimeId;
    const key = `${st.serviceTypeId}:${st.planId}:${serviceTimeId ?? date}`;
    if (this.currentKey === key && this.current) return;

    // Guard a transient null serviceTimeId (cache miss / network blip) from
    // splitting the open record mid-service: keep the current record when it's the
    // same plan + date and we just lost the occasion id.
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
      await splHistoryStore.upsert(this.current);
    }

    // Resume an existing record for this occurrence (e.g. after a restart), else create.
    const existing = await splHistoryStore.get(key);
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

  private recordSample(itemId: string, title: string | null, sample: MeterSample | null): void {
    if (!this.current) return;
    let item = this.current.items.find((i) => i.itemId === itemId);
    if (!item) {
      item = {
        itemId,
        title: title ?? "",
        sequence: this.nextSequence++,
        metrics: {},
        maxSpl: null,
        avgSpl: null,
        sampleCount: 0,
        startedAt: new Date().toISOString(),
        endedAt: null,
      };
      this.current.items.push(item);
    } else if (title && item.title !== title) {
      item.title = title;
    }
    if (!item.metrics) item.metrics = {}; // resumed legacy record

    if (sample) {
      if (this.current.meterId == null) {
        this.current.meterId = sample.meterId;
        this.current.metricKey =
          PREFERRED_METRICS.find((k) => k in sample.metrics) ?? Object.keys(sample.metrics)[0] ?? null;
      }
      // Fold EVERY reported metric into its own running max/mean.
      for (const [key, v] of Object.entries(sample.metrics)) {
        let st = item.metrics[key];
        if (!st) {
          st = { max: null, avg: null, count: 0 };
          item.metrics[key] = st;
        }
        st.max = st.max == null ? v : Math.max(st.max, v);
        st.avg = st.avg == null ? v : (st.avg * st.count + v) / (st.count + 1);
        st.count += 1;
      }
      // Keep the legacy single-metric fields populated (primary metric) for back-compat.
      const pk = this.current.metricKey;
      if (pk && pk in sample.metrics) {
        const v = sample.metrics[pk];
        item.maxSpl = item.maxSpl == null ? v : Math.max(item.maxSpl, v);
        item.avgSpl =
          item.avgSpl == null ? v : (item.avgSpl * item.sampleCount + v) / (item.sampleCount + 1);
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
    this.current.endedAt = now;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty && this.current) {
        this.dirty = false;
        void splHistoryStore.upsert(this.current);
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}

export const splRecorder = new SplRecorder();
