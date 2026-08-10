// service-recorder.ts — the bookkeeping all three service recorders share.
//
// SPL, attendance and service-timeline each record a different thing about the
// same live service, and each had grown its own copy of the same machinery:
// which occurrence is open, when to start a new record, when to close one, and
// how to persist without writing on every tick. The copies drifted, repeatedly,
// and every drift was a real bug found later:
//
//   - the stamp-once guard on `endedAt` existed in one of the three, so a
//     two-service Sunday rewrote the 9am's end to the moment the 11am began and
//     it read as a two-hour service in History and every export
//   - the debounced persist had a `.catch` in one of them, so a failed write in
//     the others was an unhandled rejection — which took the whole server down
//   - `forget()`, added when a delete was found to resurrect itself seconds
//     later, had to be written three times
//
// The persist bodies were character-identical, and two of them carried a comment
// pointing at the third. This is that comment's logical conclusion.
//
// What stays per-recorder is what genuinely differs: how a record is built, what
// resuming one means (SPL rebuilds from the raw archive; the others do not), and
// everything about sampling. The base owns only the lifecycle.

import type { PcoLiveDTO } from "../types/stage.js";
import { serviceDateKey } from "./live-service-gate.js";
import { stageController } from "./stage-controller.js";

/**
 * A gap between live-item ticks shorter than this = still the SAME service.
 *
 * A service running past its planned end rolls pickServiceTime on to the next
 * occurrence, and a PCO cache miss does the same, so the key can change while one
 * service is still running — that must NOT split the recording. A longer gap is a
 * genuinely new occurrence. Services are far enough apart that ten minutes
 * separates them cleanly while bridging any within-service lull.
 *
 * One definition: this was declared identically in all three recorders.
 */
export const SERVICE_GAP_MS = 10 * 60_000;

/** The identity every service record carries. */
export interface ServiceRecord {
  serviceKey: string;
  serviceTypeId: string | null;
  planId: string | null;
  serviceDate: string;
  serviceTimeId: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** The slice of a keyed store the lifecycle needs. */
export interface RecorderStore<T> {
  get(serviceKey: string): Promise<T | null>;
  upsert(record: T): Promise<void>;
}

/** Everything a fresh record needs that comes from the plan, not the recorder. */
export interface NewRecordContext {
  serviceKey: string;
  serviceTypeId: string;
  serviceTypeName: string | null;
  planId: string;
  planTitle: string | null;
  seriesTitle: string | null;
  serviceDate: string;
  serviceTimeId: string | null;
  serviceTimeStartsAt: string | null;
  startedAt: string;
}

export abstract class ServiceRecorder<T extends ServiceRecord> {
  /** The record being written, or the last one written. Not nulled on close —
   *  the attendance taper and every resume path read it after the service ends. */
  protected current: T | null = null;
  protected currentKey: string | null = null;
  /** Last live-item tick, for measuring the gap between services. */
  protected lastLiveAt = 0;
  /** Re-entrancy latch: the poller fires every tick and onLiveTick awaits I/O. */
  protected busy = false;
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by forget(). ensureRecord captures it before its awaits and abandons
   *  the record if it changed, so a delete cannot be undone by a tick that was
   *  already in flight when it landed. */
  private generation = 0;

  protected abstract readonly label: string;
  protected abstract readonly store: RecorderStore<T>;
  /** How long to wait before writing after a change. SPL batches far more
   *  aggressively than the others because its records are large. */
  protected abstract readonly persistDebounceMs: number;

  /** Build a record for an occurrence this box has not recorded before. */
  protected abstract createRecord(ctx: NewRecordContext, live: PcoLiveDTO): T;

  /**
   * Prepare a stored record for further writing.
   *
   * Default is to take it as-is. SPL overrides: a restart loses everything since
   * the last debounced write, and its raw archive has every sample that arrived,
   * so it rebuilds rather than resuming a record that is short by up to a minute.
   */
  protected async resumeRecord(existing: T): Promise<T> {
    return existing;
  }

  /** Called once a record has just been established or resumed. */
  protected onRecordEstablished(): void {}

  /** Active in-progress record (for hydration), or the last one recorded. */
  getCurrent(): T | null {
    return this.current;
  }

  /**
   * Drop an in-memory record so a delete of it is not undone.
   *
   * Deleting a record removes the file and the store's cache entry, but the
   * recorder still holds it; ensureRecord short-circuits on a matching key, keeps
   * appending, and the debounced persist recreates the file seconds later. The row
   * reappears and the delete reads as broken. Merging had the same shape.
   */
  forget(serviceKey: string): boolean {
    if (this.currentKey !== serviceKey && this.current?.serviceKey !== serviceKey) return false;
    this.cancelPersist();
    this.current = null;
    this.currentKey = null;
    this.generation += 1;
    return true;
  }

  /**
   * Close the current record.
   *
   * Subclasses override to close their own items and then call `super`. The
   * `endedAt` stamp happens ONCE: ensureRecord finalises again on a key change,
   * and re-stamping pushes a closed record's end forward — on a two-service
   * Sunday the 9am's end became the moment the 11am began.
   */
  protected finalizeRecord(): void {
    if (this.current && !this.current.endedAt) this.current.endedAt = new Date().toISOString();
  }

  protected schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty || !this.current) return;
      this.dirty = false;
      // Inside a timer, so nothing upstream can catch this. Losing a debounced
      // write costs the samples since the last one; an unhandled rejection here
      // would cost the server.
      void this.store
        .upsert(this.current)
        .catch((err) => console.error(`[${this.label}] persist failed:`, err));
    }, this.persistDebounceMs);
  }

  private cancelPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.dirty = false;
  }

  /**
   * Make sure `current` is the record for the occurrence this tick belongs to.
   *
   * Returns false when no record could be established, so a caller can bail
   * without repeating the check.
   */
  protected async ensureRecord(live: PcoLiveDTO, gapSinceLive = Infinity): Promise<boolean> {
    // Captured before the awaits below. forget() bumps it, so a delete landing
    // while this waits on the store abandons the work rather than re-assigning
    // this.current and writing the deleted record straight back.
    const gen = this.generation;

    const st = stageController.getState();
    const serviceTypeId = st.serviceTypeId;
    const planId = st.planId;
    if (!serviceTypeId || !planId) return false; // can't key a record yet
    // Captured, not re-read: narrowing does not survive the awaits below, and the
    // operator could switch plans mid-tick — this record belongs to the plan that
    // was selected when the tick began.
    const date = serviceDateKey(live);
    // Separate back-to-back services sharing one plan by the PCO service-time
    // occurrence (9am vs 11am). Fall back to the date when none is known.
    const serviceTimeId = live.serviceTimeId;
    const key = `${serviceTypeId}:${planId}:${serviceTimeId ?? date}`;
    if (this.currentKey === key && this.current) return true;

    // Hold the open record through a serviceTimeId change WITHIN one live service
    // — see SERVICE_GAP_MS.
    if (
      this.current &&
      this.current.serviceTypeId === serviceTypeId &&
      this.current.planId === planId &&
      this.current.serviceDate === date &&
      (serviceTimeId == null || gapSinceLive < SERVICE_GAP_MS)
    ) {
      return true;
    }

    // Key changed → finalize + persist the outgoing record.
    if (this.current) {
      this.finalizeRecord();
      await this.store.upsert(this.current);
      if (gen !== this.generation) return false; // forgotten while we waited
    }

    const existing = await this.store.get(key);
    if (gen !== this.generation) return false; // forgotten while we waited
    if (existing) {
      this.current = await this.resumeRecord(existing);
      this.current.endedAt = null; // reopened
    } else {
      this.current = this.createRecord(
        {
          serviceKey: key,
          serviceTypeId,
          serviceTypeName: st.serviceTypeName ?? null,
          planId,
          planTitle: st.planTitle,
          seriesTitle: st.planSeriesTitle ?? null,
          serviceDate: date,
          serviceTimeId: serviceTimeId ?? null,
          serviceTimeStartsAt: live.serviceTimeStartsAt,
          startedAt: new Date().toISOString(),
        },
        live,
      );
    }
    this.currentKey = key;
    this.onRecordEstablished();
    return true;
  }
}
