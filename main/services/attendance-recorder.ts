// attendance-recorder.ts — Records the building-total attendance/occupancy trend
// across a live service. Driven from the live-poller (the single server-side
// writer) alongside the SPL recorder, so it never double-counts across kiosks.
//
// On each live tick with an item in progress (and the service happening today —
// see isLiveServiceToday) it samples the latest SenSource totals, folds the peaks,
// and appends a down-sampled point to that service occurrence's trend. Records are
// keyed `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}` and persisted,
// so a mid-service restart resumes the same record.

import type { PcoLiveDTO, ServiceAttendance } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { attendanceStore } from "./attendance-store.js";
import { sensourceService } from "./sensource-service.js";
import { isLiveServiceToday } from "./spl-recorder.js";
import { stageController } from "./stage-controller.js";

const PERSIST_DEBOUNCE_MS = 4000;
/** Minimum gap between recorded trend points (attendance changes slowly). */
const SAMPLE_INTERVAL_MS = 30_000;
/** Max cadence for pushing the (O(n)) live record to trend viewers between samples. */
const LIVE_BROADCAST_MS = 5_000;
/** A gap between live-item ticks shorter than this = still the SAME service, so a
 *  serviceTimeId change (a service running past its planned end rolls pickServiceTime
 *  to the next occurrence) must NOT split the recording. A longer gap = a genuinely
 *  new service occurrence → new record. Services are far enough apart that 10 min
 *  cleanly separates them while bridging any within-service lull. */
const SERVICE_GAP_MS = 10 * 60_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class AttendanceRecorder {
  private current: ServiceAttendance | null = null;
  private currentKey: string | null = null;
  private lastLiveAt = 0; // last live-item tick (to detect the gap between services)
  private lastSampleAt = 0;
  private lastBroadcastAt = 0;
  private busy = false;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Active in-progress record (for hydration), or null when nothing is recording. */
  getCurrent(): ServiceAttendance | null {
    return this.current;
  }

  /** Called by the live-poller after each pco:live broadcast. */
  async onLiveTick(live: PcoLiveDTO | null): Promise<void> {
    if (!live || this.busy) return;
    this.busy = true;
    try {
      if (live.mode === "item" && live.currentItemId && !live.serviceEnded && isLiveServiceToday(live)) {
        const gapSinceLive = this.lastLiveAt === 0 ? Infinity : Date.now() - this.lastLiveAt;
        this.lastLiveAt = Date.now();
        await this.ensureRecord(live, gapSinceLive);
        if (!this.current) return;
        if (this.current.endedAt) this.current.endedAt = null; // resumed after a lull

        const p = sensourceService.getLatest();
        if (!p.connected || p.total.attendance == null || p.total.occupancy == null) return;
        const rawA = p.total.attendance; // SenSource Σ-entries — a running DAILY total
        const o = p.total.occupancy;
        // Baseline on the first sample so attendance is PER-SERVICE: a second service
        // in the same plan (new serviceTimeId → new record) starts its curve at 0
        // instead of inheriting the first service's count. The raw daily total is
        // kept separately as totalAttendance.
        if (this.current.attendanceBaseline == null) this.current.attendanceBaseline = rawA;
        const a = Math.max(0, rawA - this.current.attendanceBaseline);
        this.current.totalAttendance = rawA;
        this.current.peakAttendance = Math.max(this.current.peakAttendance, a);
        this.current.peakOccupancy = Math.max(this.current.peakOccupancy, o);
        // Running min "floor" — null until the first reading so an empty-room
        // moment reads 0 instead of being masked by a 0 initializer (== catches
        // legacy records persisted before this field existed).
        this.current.minOccupancy = this.current.minOccupancy == null ? o : Math.min(this.current.minOccupancy, o);
        this.current.lastAttendance = a;
        this.current.lastOccupancy = o;

        const now = Date.now();
        let appended = false;
        if (now - this.lastSampleAt >= SAMPLE_INTERVAL_MS) {
          this.current.samples.push({ t: new Date().toISOString(), attendance: a, occupancy: o });
          this.lastSampleAt = now;
          this.schedulePersist();
          appended = true;
        }
        // The full record is O(n) and the counts move slowly, so live-trend viewers
        // don't need it 1x/sec — push on a new sample, else at most every LIVE_BROADCAST_MS.
        if (appended || now - this.lastBroadcastAt >= LIVE_BROADCAST_MS) {
          this.lastBroadcastAt = now;
          broadcast("attendance:history", this.current);
        }
      } else if (this.current && !this.current.endedAt) {
        // Left "item" mode — service ended or the next service's preservice began.
        // Close the open record so the Attendance tab stops showing it as live.
        // Self-healing: an item going live above reopens it.
        this.finalizeRecord();
        await attendanceStore.upsert(this.current);
        broadcast("attendance:history", this.current);
      }
    } finally {
      this.busy = false;
    }
  }

  private async ensureRecord(live: PcoLiveDTO, gapSinceLive = Infinity): Promise<void> {
    const st = stageController.getState();
    if (!st.serviceTypeId || !st.planId) return;
    const date = todayLocal();
    const serviceTimeId = live.serviceTimeId;
    const key = `${st.serviceTypeId}:${st.planId}:${serviceTimeId ?? date}`;
    if (this.currentKey === key && this.current) return;

    // Hold the open record through a serviceTimeId change WITHIN the same live
    // service: a service running past its planned end rolls pickServiceTime to the
    // next occurrence (a null cache-miss does the same). If we were recording moments
    // ago (short gap), it's the same service — keep appending, don't split. Only a
    // long gap since the last live tick means a genuinely new service occurrence.
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
      await attendanceStore.upsert(this.current);
    }

    // Resume an existing record for this occurrence (e.g. after a restart), else create.
    const existing = await attendanceStore.get(key);
    if (existing) {
      this.current = existing;
      this.current.endedAt = null;
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
        samples: [],
        attendanceBaseline: null,
        totalAttendance: 0,
        peakAttendance: 0,
        peakOccupancy: 0,
        minOccupancy: null,
        lastAttendance: 0,
        lastOccupancy: 0,
      };
    }
    this.currentKey = key;
    this.lastSampleAt = 0; // sample immediately on the next tick
  }

  private finalizeRecord(): void {
    if (!this.current) return;
    this.current.endedAt = new Date().toISOString();
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty && this.current) {
        this.dirty = false;
        void attendanceStore.upsert(this.current);
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}

export const attendanceRecorder = new AttendanceRecorder();
