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
// Records an older version's own close left half-closed: see repairOldBootCloses.

import type { ServiceAttendance, ServiceSplHistory, ServiceTimeline, ServiceTimelineItem } from "../types/stage.js";
import { attendanceStore } from "./attendance-store.js";
import { errorMessage } from "./errors.js";
import { historyRepairsStore } from "./history-repairs-store.js";
import { scrub } from "./scrub.js";
import { splHistoryStore } from "./spl-history-store.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { closeTimelineItem, closeTimelineItems, stampItemEnds } from "./service-recorder.js";

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

/** Names the repair below in the marker store; a new repair gets a new id. */
const OLD_BOOT_CLOSE_REPAIR = "old-boot-close-gaps";
/** Each repaired record's file as it was is kept beside it under this suffix. */
export const REPAIR_BACKUP_SUFFIX = "before-repair";

/**
 * The record's last item to go live, by its start (the later one on a tie), or
 * undefined when it has none with a readable start. The only item the old boot
 * close could have left open or unmeasured: every recorder close an item gets
 * before that comes from the next item going live.
 */
function lastToGoLive<I extends { startedAt?: string | null }>(items: I[]): I | undefined {
  let last: I | undefined;
  let lastMs = -Infinity;
  for (const it of items) {
    const ms = it.startedAt ? Date.parse(it.startedAt) : NaN;
    if (Number.isFinite(ms) && ms >= lastMs) {
      last = it;
      lastMs = ms;
    }
  }
  return last;
}

/** The items of a stored record, as far as they can be read: an imported or
 *  hand-edited file need not carry an array of objects. */
function itemsOf<I>(rec: { items?: unknown }): I[] {
  return Array.isArray(rec.items) ? (rec.items.filter((it) => it != null && typeof it === "object") as I[]) : [];
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
 * That close (before v1.29.0) gave an SPL record an end and left its last item
 * open, and gave the timeline's last item the record's end (its own start, give
 * or take a second) and no length. The records it wrote keep the gap: History's
 * Actual total skips the item, and a closed SPL record holds an item still
 * running. This works out the end reconcileOpenRecords would give the record
 * now, from the same witness, and fills in only what that close would have
 * written, on the record's last item to go live:
 *
 *   - an SPL record's: that end, when it has none
 *   - a timeline's, when it has no end or the record's end with no length: that
 *     end and its length, when the occurrence's attendance saw the service run
 *     past its start; an end alone when nothing did and it has none; and when
 *     nothing did and it has an end, it is left as it is
 *   - the record's end moves to that end, which is never earlier than its own
 *
 * Nothing else is touched. An item missing its length whose end is not the
 * record's was not closed by the old close (a window edit leaves that shape when
 * it cannot read the start); an open item that is not the last to go live is a
 * shape no recorder close leaves (a merge can); both are left and logged. An
 * open record is not touched: the boot close below closes those, by the same
 * rule. Each record it changes is kept as it was beside it first (see
 * replaceKeepingPrior), and each one it changes, leaves or cannot save is
 * logged by key.
 *
 * With the attendance records not all read, nothing is written: the end would
 * be taken without the witness, and a record repaired short would no longer
 * look like one to repair once the witness reads again.
 *
 * Runs once. A repaired record no longer has the gap it looks for, so a second
 * run changes nothing; the marker saves a record it could not measure from being
 * looked at and logged again on every boot. The marker is set only when every
 * record was read and every save landed, so a failure is tried again next boot.
 * A marker that cannot be written throws: the repair then runs again next boot.
 */
async function repairOldBootCloses(witness: Map<string, number>): Promise<RepairResult | null> {
  if ((await historyRepairsStore.load())[OLD_BOOT_CLOSE_REPAIR]) return null;
  const result: RepairResult = { repaired: [], leftAsIs: [], failed: [] };
  const what = "the repair of records an older version closed at boot";
  const attendanceUnread = attendanceStore.unreadable();
  if (attendanceUnread) {
    console.log(`[reconcile] ${what} waits for the next boot, writing nothing: ${scrub(attendanceUnread.message)}`);
    return result;
  }
  const say = (key: string, line: string) => console.log(`[reconcile] ${scrub(key)}: ${line}`);
  const leave = (key: string, why: string) => {
    result.leftAsIs.push(key);
    say(key, `closed at boot with ${why}, so it is left as it is`);
  };
  const endPhrase = (end: { iso: string; measured: boolean }) =>
    `${end.iso} (${end.measured ? "the last in-service people count" : "the record's own latest stamp"})`;
  const strayNote = (n: number) => (n > 0 ? `; ${n} other item(s) with no end, which are not its last, left as they are` : "");
  const save = async <T extends { serviceKey: string }>(
    store: { replaceKeepingPrior(r: T, suffix: string): Promise<void> },
    next: T,
    done: string,
  ): Promise<void> => {
    try {
      await store.replaceKeepingPrior(next, REPAIR_BACKUP_SUFFIX);
      result.repaired.push(next.serviceKey);
      say(next.serviceKey, `repaired a record an older version closed at boot: ${done}; the file as it was is kept beside it as *.${REPAIR_BACKUP_SUFFIX}`);
    } catch (err) {
      result.failed.push(next.serviceKey);
      say(next.serviceKey, `could not repair a record an older version closed at boot (${scrub(errorMessage(err))}), so it is left as it is and tried again next boot`);
    }
  };

  for (const rec of await splHistoryStore.list()) {
    if (rec.endedAt == null) continue;
    const items = itemsOf<ServiceSplHistory["items"][number]>(rec);
    const last = lastToGoLive(items);
    const gap = last != null && last.endedAt == null;
    const stray = items.filter((it) => it !== last && it.endedAt == null).length;
    if (!gap) {
      if (stray > 0) leave(rec.serviceKey, `${stray} item(s) with no end, none of them its last`);
      continue;
    }
    const end = endFor(rec, witness);
    const next: ServiceSplHistory = structuredClone(rec);
    stampItemEnds([next.items[rec.items.indexOf(last)]!], end.iso);
    next.endedAt = end.iso;
    await save(splHistoryStore, next, `its last SPL item, left running, closed at ${endPhrase(end)}${strayNote(stray)}`);
  }

  for (const rec of await serviceTimelineStore.list()) {
    if (rec.endedAt == null) continue;
    const items = itemsOf<ServiceTimelineItem>(rec);
    const last = lastToGoLive(items);
    const gap = last != null && (last.endedAt == null || (last.actualDurationSec == null && last.endedAt === rec.endedAt));
    const stray = items.filter((it) => it !== last && it.endedAt == null).length;
    if (!gap) {
      if (stray > 0) leave(rec.serviceKey, `${stray} item(s) with no end, none of them its last`);
      continue;
    }
    const end = endFor(rec, witness);
    if (!end.measured && last.endedAt != null) {
      leave(rec.serviceKey, `no length on its last item, and no in-service people count after that item began${strayNote(stray)}`);
      continue;
    }
    const next: ServiceTimeline = structuredClone(rec);
    const item = next.items[rec.items.indexOf(last)]!;
    // Closed from the start, as the recorder's close does: the end the old
    // close gave it was a guess this rule does not make.
    if (end.measured) closeTimelineItem(item, end.iso);
    else stampItemEnds([item], end.iso);
    next.endedAt = end.iso;
    const length =
      item.actualDurationSec != null ? `a length of ${item.actualDurationSec} s` : end.measured ? "no length (its start cannot be read)" : "no length (nothing counted people past its start)";
    await save(serviceTimelineStore, next, `its last timeline item closed at ${endPhrase(end)} with ${length}${strayNote(stray)}`);
  }

  const unread = splHistoryStore.unreadable() ?? serviceTimelineStore.unreadable();
  if (unread) {
    console.log(`[reconcile] ${what} runs again next boot: ${scrub(unread.message)}`);
  } else if (result.failed.length === 0) {
    await historyRepairsStore.update((done) => ({ ...done, [OLD_BOOT_CLOSE_REPAIR]: new Date().toISOString() }));
  }
  return result;
}

export async function reconcileOpenRecords(): Promise<void> {
  const attendance = await attendanceStore.list();
  const witness = inServiceWitness(attendance);
  // Before the close below, so the records it closes now (by today's rule) are
  // not taken for the old close's. A repair that throws does not stop that
  // close; its failure is thrown once the close is done.
  let repairFailure: unknown = null;
  try {
    const repair = await repairOldBootCloses(witness);
    if (repair && repair.repaired.length + repair.leftAsIs.length + repair.failed.length > 0) {
      console.log(
        `[reconcile] records an older version closed at boot: ${repair.repaired.length} repaired, ${repair.leftAsIs.length} left as they are, ${repair.failed.length} could not be saved`,
      );
    }
  } catch (err) {
    console.log(`[reconcile] the repair of records an older version closed at boot failed, and runs again next boot: ${scrub(errorMessage(err))}`);
    repairFailure = err;
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
  if (repairFailure) throw repairFailure;
}
