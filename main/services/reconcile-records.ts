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
//
// Before that, it closed them its own way, and the records it closed then are
// repaired once, by the same rule: see repairOldBootCloses.

import type { ServiceAttendance, ServiceSplHistory, ServiceTimeline, ServiceTimelineItem } from "../types/stage.js";
import { attendanceStore } from "./attendance-store.js";
import { errorMessage } from "./errors.js";
import { historyRepairsStore } from "./history-repairs-store.js";
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
 *  "now" that could be days later than the real end. A closed record's own end
 *  counts as one of its stamps, so a repair never moves that end earlier. */
function latestOwnMs(rec: OpenRecord): number {
  let best = Date.parse(rec.startedAt);
  if (!Number.isFinite(best)) best = Date.now();
  const ended = rec.endedAt ? Date.parse(rec.endedAt) : NaN;
  if (Number.isFinite(ended) && ended > best) best = ended;
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

/**
 * Close a timeline's open items at `end`, the way the recorder would have: each
 * with its length when a clock saw the service run to that end, with an end
 * alone when nothing did. Returns how many were closed with no length.
 */
function closeTimelineAt(items: ServiceTimelineItem[], end: { iso: string; measured: boolean }): number {
  if (end.measured) {
    closeTimelineItems(items, end.iso);
    return 0;
  }
  return stampItemEnds(items, end.iso);
}

/** Names the repair below in the marker store; a new repair gets a new id. */
const OLD_BOOT_CLOSE_REPAIR = "old-boot-close-gaps";
/** Each repaired record's file as it was is kept beside it under this suffix. */
export const REPAIR_BACKUP_SUFFIX = "before-repair";

/**
 * The gap the old boot close left in a closed timeline: an item it closed at the
 * record's own end with no length (that end was the item's own start, give or
 * take a second), or one it left with no end at all. An item whose length is
 * missing but whose end is somewhere else was not closed by it, and is not
 * touched: a window edit leaves that shape when it cannot read the start.
 */
function oldCloseGap(rec: ServiceTimeline, it: ServiceTimelineItem): boolean {
  return it.endedAt == null || (it.actualDurationSec == null && it.endedAt === rec.endedAt);
}

/** What the repair did, record by record. */
interface RepairResult {
  repaired: string[];
  leftAsIs: string[];
  failed: string[];
}

/**
 * Records closed at boot before the boot close shared the recorders' close, put
 * right once by that close's rule.
 *
 * That close (before v1.29.0) gave an SPL record an end and left its items
 * open, and gave the timeline's last item the record's end and no length. The
 * records it wrote keep the gap: History's Actual total skips the item, and a
 * closed SPL record holds items still running. This works out the end
 * reconcileOpenRecords would give the record now, from the same witness, and
 * fills in only what that close would have written:
 *
 *   - an SPL record's open items get that end
 *   - a timeline's gap items get it with their length, when the occurrence's
 *     attendance saw the service run past them; when nothing did, an item with
 *     no end gets one and an item with no length keeps none, as now
 *   - the record's end moves to that end, which is never earlier than its own
 *
 * Nothing is removed or moved earlier, and a record with no gap is not written.
 * An open record is not touched: the boot close below is what closes those.
 * Each record it changes is kept as it was beside it first (see
 * replaceKeepingPrior), and each one it changes, leaves alone or cannot save is
 * logged by key.
 *
 * Runs once. A repaired record no longer has the gap it looks for, so a second
 * run changes nothing; the marker saves a record it could not measure from being
 * looked at and logged again on every boot. The marker is set only when every
 * record was read and every save landed, so a failure is tried again next boot.
 */
async function repairOldBootCloses(witness: Map<string, number>): Promise<RepairResult | null> {
  if ((await historyRepairsStore.load())[OLD_BOOT_CLOSE_REPAIR]) return null;
  const result: RepairResult = { repaired: [], leftAsIs: [], failed: [] };
  const say = (key: string, what: string) => console.log(`[reconcile] ${scrub(key)}: ${what}`);
  const endPhrase = (end: { iso: string; measured: boolean }) =>
    `${end.iso} (${end.measured ? "the last in-service people count" : "the record's own latest stamp"})`;
  const save = async <T extends { serviceKey: string }>(
    store: { replaceKeepingPrior(r: T, suffix: string): Promise<void> },
    next: T,
    what: string,
  ): Promise<void> => {
    try {
      await store.replaceKeepingPrior(next, REPAIR_BACKUP_SUFFIX);
      result.repaired.push(next.serviceKey);
      say(next.serviceKey, `repaired a record an older version closed at boot: ${what}; the file as it was is kept beside it as *.${REPAIR_BACKUP_SUFFIX}`);
    } catch (err) {
      result.failed.push(next.serviceKey);
      say(next.serviceKey, `could not repair a record an older version closed at boot (${errorMessage(err)}), so it is left as it is and tried again next boot`);
    }
  };

  for (const rec of await splHistoryStore.list()) {
    if (rec.endedAt == null || !rec.items.some((it) => it.endedAt == null)) continue;
    const end = endFor(rec, witness);
    const next: ServiceSplHistory = structuredClone(rec);
    const closed = stampItemEnds(next.items, end.iso);
    next.endedAt = end.iso;
    await save(splHistoryStore, next, `${closed} SPL item(s) it left running closed at ${endPhrase(end)}`);
  }

  for (const rec of await serviceTimelineStore.list()) {
    if (rec.endedAt == null || !rec.items.some((it) => oldCloseGap(rec, it))) continue;
    const end = endFor(rec, witness);
    const next: ServiceTimeline = structuredClone(rec);
    const gap = next.items.filter((it) => oldCloseGap(rec, it));
    // The end the old close gave these was a guess the rule does not make;
    // with a clock that saw past it, they close from open, as the recorder's do.
    if (end.measured) for (const it of gap) it.endedAt = null;
    const noLength = closeTimelineAt(next.items, end);
    const leftShort = next.items.filter((it) => it.actualDurationSec == null && it.endedAt != null).length;
    if (JSON.stringify(next) === JSON.stringify(rec)) {
      result.leftAsIs.push(rec.serviceKey);
      say(rec.serviceKey, `closed at boot with no length on its last item, and no in-service people count after that item began, so it is left as it is`);
      continue;
    }
    next.endedAt = end.iso;
    await save(
      serviceTimelineStore,
      next,
      end.measured
        ? `${gap.length} timeline item(s) closed at ${endPhrase(end)}, with their length`
        : `${noLength} timeline item(s) it left running closed at ${endPhrase(end)} with no length, ${leftShort} still with none (nothing counted people past them)`,
    );
  }

  const unread = splHistoryStore.unreadable() ?? serviceTimelineStore.unreadable() ?? attendanceStore.unreadable();
  if (unread) {
    console.log(`[reconcile] the repair of records an older version closed at boot runs again next boot: ${unread.message}`);
  } else if (result.failed.length === 0) {
    try {
      await historyRepairsStore.update((done) => ({ ...done, [OLD_BOOT_CLOSE_REPAIR]: new Date().toISOString() }));
    } catch (err) {
      console.log(`[reconcile] the repair of records an older version closed at boot could not be marked done (${errorMessage(err)}), so it runs again next boot`);
    }
  }
  return result;
}

export async function reconcileOpenRecords(): Promise<void> {
  const attendance = await attendanceStore.list();
  const witness = inServiceWitness(attendance);
  // Before the close below, so the records it closes now (by today's rule) are
  // not taken for the old close's.
  const repair = await repairOldBootCloses(witness);
  if (repair && repair.repaired.length + repair.leftAsIs.length + repair.failed.length > 0) {
    console.log(
      `[reconcile] records an older version closed at boot: ${repair.repaired.length} repaired, ${repair.leftAsIs.length} left as they are, ${repair.failed.length} could not be saved`,
    );
  }
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
      if (closeTimelineAt(rec.items, end) > 0) {
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
