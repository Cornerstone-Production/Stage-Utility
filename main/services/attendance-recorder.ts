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
import { ServiceRecorder, type NewRecordContext, type RecorderStore } from "./service-recorder.js";

/** Minimum gap between recorded trend points (attendance changes slowly). */
const SAMPLE_INTERVAL_MS = 30_000;
/** Max cadence for pushing the (O(n)) live record to trend viewers between samples. */
const LIVE_BROADCAST_MS = 5_000;

class AttendanceRecorder extends ServiceRecorder<ServiceAttendance> {
  protected readonly label = "attendance-recorder";
  protected readonly store: RecorderStore<ServiceAttendance> = attendanceStore;
  protected readonly persistDebounceMs = 4000;

  private lastSampleAt = 0;
  // Ramp/taper windows (ms), refreshed from settings each tick — see the Advanced tab.
  private preMs = DEFAULT_TAPER_WINDOW.preMin * 60_000;
  private postMs = DEFAULT_TAPER_WINDOW.postMin * 60_000;
  private lastBroadcastAt = 0;

  protected createRecord(ctx: NewRecordContext): ServiceAttendance {
    return {
      ...ctx,
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

  protected override onRecordEstablished(): void {
    this.lastSampleAt = 0; // sample immediately on the next tick
    // ...and make sure there is something fresh TO sample. Until now this
    // recorder became a demand source silently, so SenSource only sped up at
    // the end of whatever idle poll was already pending — leaving the first
    // points of the pre-service arrival ramp up to a minute old, which is the
    // steepest part of the curve and the part an operator is watching.
    sensourceService.pollNowIfIdle();
  }

  /** What (if anything) to sample this tick — see attendance-phase.ts. */
  private classify(live: PcoLiveDTO): Phase | null {
    return classifyPhase(live, {
      hasOpenRecord: this.current != null && this.current.endedAt == null,
      endedAt: this.current?.endedAt ?? null,
      heldServiceStartedAt: this.current?.serviceStartedAt ?? null,
      preMs: this.preMs,
      postMs: this.postMs,
    });
  }

  /**
   * Does this recorder still want fresh people counts?
   *
   * Exactly the window in which onLiveTick calls sensourceService.getLatest()
   * and keeps the answer: while a record is open, and on through the
   * post-service taper, which is a record that HAS an end but is still being
   * sampled as the room empties.
   */
  isSampling(): boolean {
    if (!this.current) return false;
    if (!this.current.endedAt) return true;
    const ended = Date.parse(this.current.endedAt);
    return Number.isFinite(ended) && Date.now() - ended <= this.postMs;
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

}

export const attendanceRecorder = new AttendanceRecorder();

// Tell SenSource this recorder is a consumer. Without it the idle gate counts
// only browsers, so a service with no people-count display open was recorded
// from counts up to a minute stale — the trend graph drew the poll gate rather
// than the room.
sensourceService.addDemandSource(() => attendanceRecorder.isSampling());
