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
import { clockOf } from "./app-timezone.js";
import { serviceDateKey } from "./live-service-gate.js";
import { scrub } from "./scrub.js";
import { stageController } from "./stage-controller.js";

/**
 * A gap between live-item ticks shorter than this = still the SAME service.
 *
 * A service running past its planned end rolls pickServiceTime on to the next
 * occurrence, and a PCO cache miss does the same, so the key can change while one
 * service is still running — that must NOT split the recording. Services are far
 * enough apart that ten minutes separates them cleanly while bridging any
 * within-service lull.
 *
 * It is NOT on its own how back-to-back services are told apart: the second
 * service's pre-service item goes live seconds after the first service's last,
 * so the gap stays small across a real boundary. See
 * shouldHoldThroughServiceTimeChange, which decides on the new occurrence's own
 * start time and falls back to this gap only when there is no start to read.
 *
 * One definition: this was declared identically in all three recorders.
 *
 * Exported so a recorder can tell a leftover PCO item (still live from BEFORE
 * this record opened) from one that genuinely started within the same service —
 * see openItem in service-timeline-recorder.ts.
 */
export const SERVICE_GAP_MS = 10 * 60_000;

/** One entry in a record's per-item list, as the lookups below need to see it. */
export interface RecordedItem {
  itemId: string;
  endedAt: string | null;
}

/**
 * The LAST entry for `itemId`, or undefined.
 *
 * A plan item can legitimately appear more than once in a record — a song
 * reprised, or a second service's pre-service item landing in the record before
 * the occurrence split catches up. Entries are pushed in the order they went
 * live, so the last match is the current run; `items.find` returns the FIRST,
 * which is how a re-run rewrote a run that had already finished hours earlier.
 */
export function lastItemEntry<T extends RecordedItem>(items: T[], itemId: string): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) if (items[i]!.itemId === itemId) return items[i];
  return undefined;
}

/**
 * Is an item going live again a step BACK to an entry still in play, or a
 * genuine second run that deserves its own entry?
 *
 * A step back is what an operator does within a service — jump to the previous
 * song, replay a video. It lands within seconds or minutes of the entry closing.
 * An entry that closed more than SERVICE_GAP_MS ago is finished history: on
 * 18 Sep 2026 a second service's items reopened the first service's, and the
 * first item's recorded length grew to 6753 s.
 *
 * An entry never closed is the same run by definition — say yes, rather than
 * pushing a duplicate alongside an entry that is still open.
 *
 * `goingLiveAtMs` is PCO's `live_start_at` for the run now on air, never this
 * box's clock (see itemLiveSinceMs), and that is what makes a restart safe: an
 * entry closed AFTER the run went live in Planning Center was closed for a LOCAL
 * reason — the server went down, a meter stopped reporting — while the item
 * itself never stopped, so the difference below is negative and it reopens
 * however long the box was away. Judged against `now` instead, half an hour of
 * downtime splits an item that has been on air throughout.
 */
export function isStepBackTo(entry: RecordedItem, goingLiveAtMs: number): boolean {
  if (!entry.endedAt) return true;
  const endedMs = Date.parse(entry.endedAt);
  if (!Number.isFinite(endedMs) || !Number.isFinite(goingLiveAtMs)) return true; // no clock to judge by
  return goingLiveAtMs - endedMs < SERVICE_GAP_MS;
}

/**
 * When the current item went live, as Planning Center reports it.
 *
 * PCO's `live_start_at` is the one clock both recorders can agree on, and the
 * reason this is a shared helper rather than a line in each of them: the SPL
 * recorder judged a step back by its own wall clock instead, so a restart or a
 * meter outage longer than SERVICE_GAP_MS split an item on the SPL record that
 * the timeline record kept whole. Two recorders, one live service, two different
 * answers about what happened.
 *
 * Falls back to now when PCO reports no start — an item that is live with no
 * `live_start_at` has only just been put on air, or the field is missing on an
 * older build, and both mean "now" closely enough.
 */
export function itemLiveSinceMs(live: { liveStartAt: string | null }): number {
  const parsed = live.liveStartAt ? Date.parse(live.liveStartAt) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** The identity every service record carries. */
export interface ServiceRecord {
  serviceKey: string;
  serviceTypeId: string | null;
  planId: string | null;
  serviceDate: string;
  serviceTimeId: string | null;
  startedAt: string;
  endedAt: string | null;
  /**
   * The item this record OPENED with — the first live item id any of the three
   * recorders saw for this occurrence. Set once, by ensureRecord's
   * captureOpeningItem, and never overwritten.
   *
   * SPL and attendance keep no item list of their own to derive this from
   * later (attendance keeps none at all; SPL's is per-metric, not ordered by
   * arrival), so it travels on the record itself — one field, set in one
   * place, read by all three. Persisted, so a restart mid-hold still knows it.
   * Absent (undefined) on a record made before this existed, which is treated
   * the same as null: unknown, so shouldHoldThroughServiceTimeChange falls
   * back to the ten-minute/gap rule alone.
   */
  openingItemId?: string | null;
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
  /** The `<old>→<new>` service-time transition already logged, so the hold
   *  decision is announced once and not on every tick for the length of an
   *  overrun. Cleared when a record is established. */
  private loggedServiceTimeChange: string | null = null;

  protected abstract readonly label: string;
  protected abstract readonly store: RecorderStore<T>;
  /** How long to wait before writing after a change. SPL batches far more
   *  aggressively than the others because its records are large. */
  protected abstract readonly persistDebounceMs: number;

  /** Build a record for an occurrence this box has not recorded before. */
  protected abstract createRecord(ctx: NewRecordContext, live: PcoLiveDTO): T;

  /**
   * Publish a record this recorder just closed, on this recorder's own channel,
   * in the same shape a live push already uses (broadcastTimeline for the
   * timeline recorder; `broadcast("…:history", record)` for the other two).
   *
   * Exists for exactly one caller: ensureRecord's split path below. Every other
   * close a recorder produces (onLiveTick leaving "item"/service mode) already
   * broadcasts inline right after it persists, but the split finalizes and
   * persists the OUTGOING record and then moves straight on to the incoming
   * one — the new record's first push was the only broadcast a split ever
   * produced, so a History page open at the moment of a split never heard the
   * old occurrence close and kept showing it "recording" until the page was
   * reloaded (24 Sep 2026, all three recorders).
   */
  protected abstract publishClosed(record: T): void;

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
   * Is this recorder writing to `serviceKey` right now?
   *
   * `currentKey` alone does not answer that: it is set when a record is
   * established and only cleared by forget(), so it still names last Sunday's
   * service on Tuesday. Liveness needs all three — the recorder holds this key,
   * the record is still open, and a live item ticked within the gap that
   * separates one occurrence from the next.
   *
   * This is what makes editing history safe to reason about. Deleting, merging
   * or re-windowing a record the recorder is actively appending to is a race no
   * ordering of forget() and upsert() wins: the operator's edit and the next
   * tick are both correct about what they hold, and one of them loses. The
   * routes refuse instead, so there is nothing to lose.
   */
  isRecording(serviceKey: string): boolean {
    if (this.currentKey !== serviceKey || !this.current) return false;
    if (this.current.endedAt) return false;
    return this.lastLiveAt !== 0 && Date.now() - this.lastLiveAt < SERVICE_GAP_MS;
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
  protected finalizeRecord(iso = new Date().toISOString()): void {
    if (this.current && !this.current.endedAt) this.current.endedAt = iso;
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
   * The key changed while the SAME plan, on the SAME date, is still live. Is this
   * one service whose occurrence id moved under it, or the next service starting?
   *
   * The gap between live ticks cannot tell them apart. Back-to-back services share
   * a plan, and the second service's pre-service item goes live seconds after the
   * first one's last item, so `gapSinceLive` stays at seconds across the boundary —
   * on 18 Sep 2026 that merged two services into one record whose first item read
   * as 1h 52m long and whose second service had no record at all.
   *
   * The new occurrence's own start time does tell them apart. `pickServiceTime`
   * rolls to the NEXT occurrence when a service runs past its planned end, and a
   * PCO cache miss does the same — in both the occurrence now selected is still in
   * the future. So: hold only while the new occurrence starts more than
   * SERVICE_GAP_MS from now. One that has begun, or is about to, is a new service.
   *
   * Two cases keep the old gap rule, because there is no occurrence start to
   * compare: PCO reporting no serviceTimeId at all (a cache miss — the key falls
   * back to the date), and an occurrence with no `serviceTimeStartsAt`. A record
   * opened before PCO knew its occurrence (`serviceTimeId` null on the record) also
   * holds: that is the same cache miss resolving, not a second service.
   *
   * Known residual: where the first occurrence carries an explicit `ends_at`,
   * pickServiceTime rolls over at that end rather than at the next occurrence's
   * start, so up to SERVICE_GAP_MS of the second service's pre-service can still
   * land in the first record before the split. That is the same window the
   * overrun case needs, and it is bounded — not the unbounded merge this fixes.
   *
   * One more thing beats the clock: the OPENING item of this record going live
   * again while held (Doors, tonight) is the next service actually starting,
   * whatever the ten-minute rule still says — an operator does not restart a
   * service's first item mid-overrun, but the next service always starts with
   * one. A reprise of any OTHER item (a song, a step back) is not evidence of
   * that and keeps holding. See openingItemId / captureOpeningItem.
   */
  private shouldHoldThroughServiceTimeChange(
    live: PcoLiveDTO,
    serviceTimeId: string | null,
    gapSinceLive: number,
  ): boolean {
    const from = this.current?.serviceTimeId ?? null;
    if (serviceTimeId == null || from == null) return true; // no two occurrences to compare
    const startsAtMs = live.serviceTimeStartsAt ? Date.parse(live.serviceTimeStartsAt) : NaN;
    if (!Number.isFinite(startsAtMs)) return gapSinceLive < SERVICE_GAP_MS;

    const untilMs = startsAtMs - Date.now();
    const hold = untilMs > SERVICE_GAP_MS;

    // The opening item overrides a hold outright. Logged unconditionally, not
    // through loggedServiceTimeChange: the split below changes currentKey on
    // THIS tick, so this transition is never asked about again and nothing can
    // double-log it.
    const openingItemId = this.current?.openingItemId ?? null;
    if (hold && openingItemId != null && live.currentItemId === openingItemId) {
      console.log(
        `[service-recorder] ${this.label}: "${scrub(live.label ?? live.currentItemTitle ?? openingItemId)}" went live again during the hold — the next service has begun, closing ${this.current?.serviceKey ?? "the open record"} and opening a new record`,
      );
      return false;
    }

    // Keyed on the decision as well as the transition: a hold announced 35
    // minutes out is followed, ten minutes out, by the split it was holding
    // for, and that split is news too. Keyed on the transition alone, it was
    // silent: the log read "holding" and never said the record closed.
    const transition = `${from}→${serviceTimeId}:${hold ? "hold" : "split"}`;
    if (this.loggedServiceTimeChange !== transition) {
      this.loggedServiceTimeChange = transition;
      const closing = `closing ${this.current?.serviceKey ?? "the open record"} and opening a new record`;
      console.log(
        hold
          ? `[service-recorder] ${this.label}: service time ${from} → ${serviceTimeId}, holding the open record (next occurrence starts in ${Math.round(untilMs / 60_000)} min)`
          : untilMs > 0
            ? `[service-recorder] ${this.label}: service time ${from} → ${serviceTimeId} starts in ${Math.max(1, Math.round(untilMs / 60_000))} min, ${closing}`
            : `[service-recorder] ${this.label}: service time ${from} → ${serviceTimeId} began at ${clockOf(startsAtMs)}, ${closing}`,
      );
    }
    return hold;
  }

  /**
   * Remember the item THIS record opened with — the first live tick to reach
   * here with an item id, whichever recorder sees it first.
   *
   * The timeline and SPL recorders only call ensureRecord once an item is
   * live, so this fires the moment their record is created. Attendance can
   * establish a record during the pre-service arrival ramp with no item live
   * yet (see attendance-phase.ts), so its record's openingItemId starts null
   * and this backfills it on whichever later tick brings the first real item —
   * the same value the other two captured, because this is the one place any
   * of the three ever sets it. Never overwritten once set, so a resumed or
   * reopened record keeps the value it was created with.
   */
  private captureOpeningItem(live: PcoLiveDTO): void {
    if (this.current && this.current.openingItemId == null && live.currentItemId) {
      this.current.openingItemId = live.currentItemId;
    }
  }

  /**
   * Make sure `current` is the record for the occurrence this tick belongs to.
   *
   * Returns nothing on purpose. An earlier version returned a boolean described
   * as "false = could not establish a record, bail" — but it also returns early
   * when PCO momentarily has no serviceTypeId while `current` still holds a
   * perfectly good open record, and bailing there would drop samples on every
   * cache blip mid-service. Callers test `this.current`, which is the question
   * they actually mean.
   */
  protected async ensureRecord(live: PcoLiveDTO, gapSinceLive = Infinity): Promise<void> {
    // Captured before the awaits below. forget() bumps it, so a delete landing
    // while this waits on the store abandons the work rather than re-assigning
    // this.current and writing the deleted record straight back.
    const gen = this.generation;

    const st = stageController.getState();
    const serviceTypeId = st.serviceTypeId;
    const planId = st.planId;
    if (!serviceTypeId || !planId) return; // can't key a record yet
    // Captured, not re-read: narrowing does not survive the awaits below, and the
    // operator could switch plans mid-tick — this record belongs to the plan that
    // was selected when the tick began.
    const date = serviceDateKey(live);
    // Separate back-to-back services sharing one plan by the PCO service-time
    // occurrence (9am vs 11am). Fall back to the date when none is known.
    const serviceTimeId = live.serviceTimeId;
    const key = `${serviceTypeId}:${planId}:${serviceTimeId ?? date}`;
    if (this.currentKey === key && this.current) {
      this.captureOpeningItem(live); // backfill for a record that opened before any item was live
      return;
    }

    // Hold the open record through a serviceTimeId change WITHIN one live service
    // — see SERVICE_GAP_MS.
    if (
      this.current &&
      this.current.serviceTypeId === serviceTypeId &&
      this.current.planId === planId &&
      this.current.serviceDate === date &&
      this.shouldHoldThroughServiceTimeChange(live, serviceTimeId, gapSinceLive)
    ) {
      return;
    }

    // Key changed → finalize + persist the outgoing record, then publish it on
    // this recorder's own channel — see publishClosed's doc above.
    if (this.current) {
      this.finalizeRecord();
      const outgoing = this.current;
      await this.store.upsert(outgoing);
      if (gen !== this.generation) return; // forgotten while we waited
      this.publishClosed(outgoing);
    }

    const existing = await this.store.get(key);
    if (gen !== this.generation) return; // forgotten while we waited
    if (existing) {
      const resumed = await this.resumeRecord(existing);
      // Checked again: resumeRecord awaits too, and for SPL it is the expensive
      // one — it reads the whole raw archive to rebuild. A delete landing during
      // that rebuild would otherwise be undone by the record it produces, which
      // is exactly what forget() exists to prevent.
      if (gen !== this.generation) return;
      this.current = resumed;
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
    this.loggedServiceTimeChange = null; // the next transition out of THIS record is news again
    this.captureOpeningItem(live);
    this.onRecordEstablished();
  }
}
