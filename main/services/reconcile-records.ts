// reconcile-records.ts — On startup, finalize any history record left open
// (endedAt == null) by a prior run that didn't close it (crash, or a process
// restart after a service — the in-memory "current record" is gone, so nothing
// would ever close the on-disk record and it shows "recording…" forever).
//
// Safe: at boot the service can't actually be live (we weren't running), and if it
// IS still live, the recorder resumes the record on the next tick (ensureRecord
// clears endedAt again, and the item on air reopens). So this only closes true
// orphans.
//
// Closed the way the recorders close a record, with their own item closers from
// service-recorder.ts: an SPL record's items get an end, a timeline's get an end
// and a length. The one difference is the clock. This runs after the fact, so
// "now" is never the end; the end is the latest moment the occurrence's records
// show the service running.

import type { ServiceAttendance } from "../types/stage.js";
import { attendanceStore } from "./attendance-store.js";
import { scrub } from "./scrub.js";
import { splHistoryStore } from "./spl-history-store.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { closeTimelineItems, stampItemEnds } from "./service-recorder.js";

interface OpenRecord {
  serviceKey: string;
  startedAt: string;
  endedAt: string | null;
  samples?: { t: string }[];
  items?: { startedAt?: string; endedAt?: string | null }[];
}

/** Best "end" for an orphan from its own stamps = the latest timestamp it holds
 *  (last sample / item), falling back to when it started — never a boot-time
 *  "now" that could be days later than the real end. */
function latestOwnMs(rec: OpenRecord): number {
  let best = Date.parse(rec.startedAt);
  if (!Number.isFinite(best)) best = Date.now();
  for (const s of rec.samples ?? []) {
    const p = Date.parse(s.t);
    if (Number.isFinite(p) && p > best) best = p;
  }
  for (const it of rec.items ?? []) {
    for (const v of [it.endedAt, it.startedAt]) {
      const p = v ? Date.parse(v) : NaN;
      if (Number.isFinite(p) && p > best) best = p;
    }
  }
  return best;
}

/**
 * The last attendance sample per occurrence taken while the service ran: the one
 * clock that keeps ticking through a plan item.
 *
 * The item-shaped records stamp only item changes, and the recorder stamps a
 * change from this host's clock a moment AFTER Planning Center's live_start_at
 * for the incoming item. So their own latest stamp sits a second or two into the
 * last item, and a length computed from it is an item that ran for two seconds.
 * Attendance samples every 30 s while the service runs, pre-roll items above
 * SERVICE START included ("pre" in item mode, before serviceStartedAt). Taper
 * samples ("post") are the room emptying after the service and are left out.
 * So is a "pre" sample after serviceStartedAt: that is the NEXT occurrence's
 * arrival ramp, which a recorder holding the closed record through the
 * service-time change used to append to it. Records written before that was
 * fixed still carry those samples.
 *
 * Walks every attendance record, closed ones too, so a record missing its
 * samples (an import, a hand-edited file) is skipped rather than stopping every
 * orphan from being closed.
 */
function inServiceWitness(records: ServiceAttendance[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const rec of records) {
    const serviceStartMs = rec.serviceStartedAt ? Date.parse(rec.serviceStartedAt) : NaN;
    for (const s of rec.samples ?? []) {
      if (!s || s.phase === "post") continue;
      const t = Date.parse(s.t);
      if (!Number.isFinite(t)) continue;
      if (s.phase === "pre" && Number.isFinite(serviceStartMs) && t >= serviceStartMs) continue;
      if (t > (out.get(rec.serviceKey) ?? -Infinity)) out.set(rec.serviceKey, t);
    }
  }
  return out;
}

/** The end for an orphan, and whether a clock saw the service run up to it. */
function endFor(rec: OpenRecord, witness: Map<string, number>): { iso: string; measured: boolean } {
  const own = latestOwnMs(rec);
  const seen = witness.get(rec.serviceKey);
  const measured = seen != null && seen > own;
  return { iso: new Date(measured ? seen : own).toISOString(), measured };
}

export async function reconcileOpenRecords(): Promise<void> {
  const attendance = await attendanceStore.list();
  const witness = inServiceWitness(attendance);
  let closed = 0;

  for (const rec of attendance) {
    if (rec.endedAt == null) {
      rec.endedAt = endFor(rec, witness).iso;
      await attendanceStore.upsert(rec);
      closed++;
    }
  }
  for (const rec of await splHistoryStore.list()) {
    if (rec.endedAt == null) {
      const end = endFor(rec, witness);
      stampItemEnds(rec.items, end.iso);
      rec.endedAt = end.iso;
      await splHistoryStore.upsert(rec);
      closed++;
    }
  }
  for (const rec of await serviceTimelineStore.list()) {
    if (rec.endedAt == null) {
      const end = endFor(rec, witness);
      if (end.measured) {
        closeTimelineItems(rec.items, end.iso);
      } else if (stampItemEnds(rec.items, end.iso) > 0) {
        // Nothing saw the last item run past its own start, so its length is
        // unknown, and stays null rather than reading as a two-second item.
        console.log(
          `[reconcile] ${scrub(rec.serviceKey)}: no in-service people count after the last item change, so that item is closed with no length`,
        );
      }
      rec.endedAt = end.iso;
      await serviceTimelineStore.upsert(rec);
      closed++;
    }
  }

  if (closed > 0) console.log(`[reconcile] closed ${closed} orphaned open record(s) from a prior run`);
}
