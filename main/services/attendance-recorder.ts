// attendance-recorder.ts — Records the building-total attendance/occupancy trend
// across a live service. Driven from the live-poller (the single server-side
// writer) alongside the SPL recorder, so it never double-counts across kiosks.
//
// On each live tick with an item in progress (and the service happening today —
// see isLiveServiceToday) it samples the latest SenSource totals, folds the peaks,
// and appends a down-sampled point to that service occurrence's trend. Records are
// keyed `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}` and persisted,
// so a mid-service restart resumes the same record.

import type { AttendanceSample, PcoLiveDTO, ServiceAttendance } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { sampleArchive } from "./archive/sample-archive.js";
import { attendanceStore } from "./attendance-store.js";
import { settingsStore, DEFAULT_TAPER_WINDOW } from "./settings-store.js";
import { sensourceService } from "./sensource-service.js";
import { classifyPhase, type Phase } from "./attendance-phase.js";
import { serviceDateKey } from "./live-service-gate.js";
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

class AttendanceRecorder {
  private current: ServiceAttendance | null = null;
  private currentKey: string | null = null;
  private lastLiveAt = 0; // last live-item tick (to detect the gap between services)
  private lastSampleAt = 0;
  // Ramp/taper windows (ms), refreshed from settings each tick — see the Advanced tab.
  private preMs = DEFAULT_TAPER_WINDOW.preMin * 60_000;
  private postMs = DEFAULT_TAPER_WINDOW.postMin * 60_000;
  private lastBroadcastAt = 0;
  private busy = false;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by forget(). ensureRecord captures it before its awaits and abandons
   *  the record if it changed, so a delete cannot be undone by a tick that was
   *  already in flight when it landed. */
  private generation = 0;

  /** Active in-progress record (for hydration), or null when nothing is recording. */
  getCurrent(): ServiceAttendance | null {
    return this.current;
  }

  /** What (if anything) to sample this tick — see attendance-phase.ts. */
  private classify(live: PcoLiveDTO): Phase | null {
    return classifyPhase(live, {
      hasOpenRecord: this.current != null && this.current.endedAt == null,
      endedAt: this.current?.endedAt ?? null,
      heldServiceTimeId: this.current?.serviceTimeId ?? null,
      preMs: this.preMs,
      postMs: this.postMs,
    });
  }

  /** Called by the live-poller after each pco:live broadcast. */
  async onLiveTick(live: PcoLiveDTO | null): Promise<void> {
    if (!live || this.busy) return;
    this.busy = true;
    try {
      // Refresh the ramp/taper windows from settings (cached read — cheap).
      const tw = (await settingsStore.get()).taperWindow ?? DEFAULT_TAPER_WINDOW;
      this.preMs = Math.max(0, tw.preMin) * 60_000;
      this.postMs = Math.max(0, tw.postMin) * 60_000;

      const phase = this.classify(live);
      if (phase === null) {
        // Nothing to sample. Close any record left open (mode dropped with no end
        // header, before the cooldown branch can tag it) so it stops reading as live;
        // the next tick's cooldown check then resumes it as "post".
        if (this.current && !this.current.endedAt) {
          this.finalizeRecord();
          await attendanceStore.upsert(this.current);
          broadcast("attendance:history", this.current);
        }
        return;
      }

      const gapSinceLive = this.lastLiveAt === 0 ? Infinity : Date.now() - this.lastLiveAt;
      if (live.mode === "item") this.lastLiveAt = Date.now(); // gap is measured between live items

      // Establish the record for pre/service; "post" only ever samples into the
      // record we just ended (never spins up a new one for an emptying room).
      if (phase === "service" || phase === "pre") await this.ensureRecord(live, gapSinceLive);
      if (!this.current) return;

      if (phase === "service") {
        if (this.current.endedAt) this.current.endedAt = null; // resumed after a lull/cooldown
        if (!this.current.serviceStartedAt) this.current.serviceStartedAt = new Date().toISOString();
      } else if (phase === "post") {
        this.finalizeRecord(); // stamp the service-end boundary once (guarded)
      }

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

      // Archive EVERY reading, not just the 30s-gated ones the trend keeps: the
      // record below stores what the chart needs, and the point of the raw layer is
      // to outlive today's idea of what that is. The un-baselined daily total goes
      // along too, since the baseline is a decision this recorder made.
      sampleArchive.recordAttendance(
        { serviceKey: this.current.serviceKey, serviceDate: this.current.serviceDate },
        { attendance: a, occupancy: o, rawAttendance: rawA },
      );

      // Only the service proper feeds Peak/Lowest/Last — the pre-service ramp and the
      // post-service taper would otherwise drag the "floor"/"last" toward an empty room.
      if (phase === "service") {
        this.current.peakAttendance = Math.max(this.current.peakAttendance, a);
        this.current.peakOccupancy = Math.max(this.current.peakOccupancy, o);
        // Running min "floor" — null until the first reading so an empty-room
        // moment reads 0 instead of being masked by a 0 initializer (== catches
        // legacy records persisted before this field existed).
        this.current.minOccupancy = this.current.minOccupancy == null ? o : Math.min(this.current.minOccupancy, o);
        this.current.lastAttendance = a;
        this.current.lastOccupancy = o;
      }

      const now = Date.now();
      let appended = false;
      if (now - this.lastSampleAt >= SAMPLE_INTERVAL_MS) {
        const sample: AttendanceSample = { t: new Date().toISOString(), attendance: a, occupancy: o };
        if (phase !== "service") sample.phase = phase; // tag ramp/taper; in-service stays untagged
        this.current.samples.push(sample);
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
    } finally {
      this.busy = false;
    }
  }

  private async ensureRecord(live: PcoLiveDTO, gapSinceLive = Infinity): Promise<void> {
    // Captured before any await below. forget() bumps it, so a delete that lands
    // while this is waiting on the store abandons the work instead of re-assigning
    // this.current and writing the deleted record straight back.
    const gen = this.generation;
    const st = stageController.getState();
    if (!st.serviceTypeId || !st.planId) return;
    const date = serviceDateKey(live);
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
    if (gen !== this.generation) return; // forgotten while we waited
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
        serviceStartedAt: null,
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
    // Stamp the service-end boundary only once — re-finalizing (e.g. as the next
    // service's preservice starts, or each cooldown tick) must not push endedAt
    // later and swallow the taper into the service window.
    if (!this.current.endedAt) this.current.endedAt = new Date().toISOString();
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
    this.generation += 1;
    return true;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty && this.current) {
        this.dirty = false;
        // Inside a timer, so nothing upstream can catch this. Losing a debounced
        // write costs the samples since the last one; an unhandled rejection here
        // would cost the server.
        void attendanceStore
          .upsert(this.current)
          .catch((err) => console.error("[attendance-recorder] persist failed:", err));
      }
    }, PERSIST_DEBOUNCE_MS);
  }
}

export const attendanceRecorder = new AttendanceRecorder();
