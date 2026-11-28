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

/** The items of a stored record, as far as they can be read: an imported or
 *  hand-edited file need not carry an array of objects. */
function itemsOf<I>(rec: { items?: unknown }): I[] {
  return Array.isArray(rec.items) ? (rec.items.filter((it) => it != null && typeof it === "object") as I[]) : [];
}

/** Best "end" for an orphan from its own stamps = the latest timestamp it holds
 *  (last sample / item), falling back to when it started — never a boot-time
 *  "now" that could be days later than the real end. */
function latestOwnMs(rec: OpenRecord): number {
  let best = Date.parse(rec.startedAt);
  if (!Number.isFinite(best)) best = Date.now();
  for (const s of Array.isArray(rec.samples) ? rec.samples : []) {
    const p = s ? Date.parse(s.t) : NaN;
    if (Number.isFinite(p) && p > best) best = p;
  }
  for (const it of itemsOf<{ startedAt?: string; endedAt?: string | null }>(rec)) {
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

/** What a repair did, record by record. `waiting` is why it wrote nothing. */
export interface GapRepairResult {
  repaired: string[];
  leftAsIs: string[];
  failed: string[];
  waiting: string | null;
}

/** The latest moment any of these items holds, start or end. */
function latestItemStampMs(items: { startedAt?: string | null; endedAt?: string | null }[]): number {
  let best = -Infinity;
  for (const it of items) {
    for (const v of [it.startedAt, it.endedAt]) {
      const ms = v ? Date.parse(v) : NaN;
      if (Number.isFinite(ms) && ms > best) best = ms;
    }
  }
  return best;
}

/** A later of two ISO stamps (the first when the second cannot be read). */
function laterIso(a: string, b: string | null): string {
  const bMs = b ? Date.parse(b) : NaN;
  return Number.isFinite(bMs) && bMs > Date.parse(a) ? b! : a;
}

/**
 * Put right the gap a boot-time close left in closed history records, by the
 * close reconcileOpenRecords makes now. Shared by the one-time boot repair
 * (repairOldBootCloses), an archive import and a rebuild from raw, which bring
 * in or recreate records the boot repair never saw. `only` limits it to those
 * keys.
 *
 * The gap. A close before v1.29.0 gave an SPL record an end and left the item on
 * air open, and gave the timeline's item on air an end (the record's last stamp,
 * a moment after that item went live) and no length; v1.29.0's own close still
 * leaves no length when nothing measured the item. A timeline item with an end,
 * a readable start and no length is only ever written by a boot close: every
 * other close measures it. History's Actual total skips such an item, and a
 * closed SPL record holds an item still running.
 *
 * The fill, on the one item that was on air when the record was closed, and
 * only what the close would have written:
 *
 *   - the end: the occurrence's last in-service people count, when it is later
 *     than every stamp the record's items hold; else that latest stamp
 *   - an SPL item gets that end; a timeline item gets it with its length when a
 *     people count measured it, an end alone when nothing did and it had none,
 *     and is left as it is when nothing did and it had an end
 *   - the record's end moves to that end when it is later, never earlier, so an
 *     end an operator set later stays
 *
 * Which item was on air. SPL: the record's one item with no end. Timeline: the
 * gap item with no end, or whose end is the latest stamp its items hold (the old
 * close stamped exactly that). Not by start order: a step back reopens an
 * earlier entry with its first start. More than one such item is a shape no
 * close leaves (two old fragments merged in History can) and is left and
 * logged; a merge leaving one is indistinguishable from a step back, and is
 * filled like one. A timeline gap item that is not the one on air (a record
 * resumed on another item after the old close) has nothing to measure it by
 * and is left and logged.
 *
 * An open record is not touched: reconcileOpenRecords closes those by the same
 * rule, and a live recorder owns them. Each record it changes is copied as it
 * was beside it first (see replaceKeepingPrior), and each record with the gap
 * it changes, leaves or cannot save is logged by key. A record with no gap is
 * not written, so a second run changes nothing.
 *
 * With the attendance records not all read, nothing is written: the end would
 * be taken without the witness, and a record repaired short would no longer
 * look like one to repair once the witness reads again.
 */
export async function repairBootCloseGaps(only?: ReadonlySet<string>): Promise<GapRepairResult> {
  const result: GapRepairResult = { repaired: [], leftAsIs: [], failed: [], waiting: null };
  const attendance = await attendanceStore.list();
  const attendanceUnread = attendanceStore.unreadable();
  if (attendanceUnread) {
    result.waiting = scrub(attendanceUnread.message);
    console.log(`[reconcile] records closed at boot are not repaired while an attendance record cannot be read: ${result.waiting}`);
    return result;
  }
  const witness = inServiceWitness(attendance);
  const say = (key: string, line: string) => console.log(`[reconcile] ${scrub(key)}: ${line}`);
  const leave = (key: string, why: string) => {
    result.leftAsIs.push(key);
    say(key, `closed at boot with ${why}, so it is left as it is`);
  };
  const endPhrase = (end: { iso: string; measured: boolean }) =>
    `${end.iso} (${end.measured ? "the last in-service people count" : "the latest stamp its items hold"})`;
  const save = async <T extends { serviceKey: string }>(
    store: { replaceKeepingPrior(r: T, suffix: string): Promise<boolean> },
    next: T,
    done: string,
  ): Promise<void> => {
    try {
      const copied = await store.replaceKeepingPrior(next, REPAIR_BACKUP_SUFFIX);
      result.repaired.push(next.serviceKey);
      say(
        next.serviceKey,
        `repaired a record closed at boot: ${done}; ${copied ? "the file as it was is kept" : "an earlier copy of it is already kept, and stays"} beside it as *.${REPAIR_BACKUP_SUFFIX}`,
      );
    } catch (err) {
      result.failed.push(next.serviceKey);
      say(next.serviceKey, `could not repair a record closed at boot (${scrub(errorMessage(err))}), so it is left as it is`);
    }
  };
  const wanted = (key: string) => !only || only.has(key);

  for (const rec of await splHistoryStore.list()) {
    if (rec.endedAt == null || !wanted(rec.serviceKey)) continue;
    const gap = itemsOf<ServiceSplHistory["items"][number]>(rec).filter((it) => it.endedAt == null);
    if (gap.length === 0) continue;
    if (gap.length > 1) {
      leave(rec.serviceKey, `${gap.length} items with no end, more than the one any close leaves`);
      continue;
    }
    const end = endFor(rec, witness);
    const next: ServiceSplHistory = structuredClone(rec);
    stampItemEnds([next.items[rec.items.indexOf(gap[0]!)]!], end.iso);
    next.endedAt = laterIso(end.iso, rec.endedAt);
    await save(splHistoryStore, next, `the SPL item it left running closed at ${endPhrase(end)}`);
  }

  for (const rec of await serviceTimelineStore.list()) {
    if (rec.endedAt == null || !wanted(rec.serviceKey)) continue;
    const items = itemsOf<ServiceTimelineItem>(rec);
    const unmeasured = items.filter(
      (it) => it.endedAt == null || (it.actualDurationSec == null && Number.isFinite(Date.parse(it.startedAt))),
    );
    if (unmeasured.length === 0) continue;
    const latest = latestItemStampMs(items);
    const onAir = unmeasured.filter((it) => it.endedAt == null || Date.parse(it.endedAt) === latest);
    const others = unmeasured.length - onAir.length;
    if (onAir.length !== 1) {
      leave(
        rec.serviceKey,
        onAir.length > 1
          ? `${onAir.length} items with no end or no length at its end, more than the one any close leaves`
          : `${others} item(s) with no length that were not on air at its end, which nothing measured`,
      );
      continue;
    }
    const gapItem = onAir[0]!;
    const othersNote = others > 0 ? `; ${others} other item(s) with no length, not on air at its end, left as they are` : "";
    const end = endFor(rec, witness);
    if (!end.measured && gapItem.endedAt != null) {
      leave(rec.serviceKey, `no length on the item that was on air, and no in-service people count after that item began${othersNote}`);
      continue;
    }
    const next: ServiceTimeline = structuredClone(rec);
    const item = next.items[rec.items.indexOf(gapItem)]!;
    // Closed from the start, as the recorder's close does: the end the old
    // close gave it was a guess this rule does not make.
    if (end.measured) closeTimelineItem(item, end.iso);
    else stampItemEnds([item], end.iso);
    next.endedAt = laterIso(end.iso, rec.endedAt);
    const length =
      item.actualDurationSec != null ? `a length of ${item.actualDurationSec} s` : end.measured ? "no length (its start cannot be read)" : "no length (nothing counted people past its start)";
    await save(serviceTimelineStore, next, `the timeline item that was on air closed at ${endPhrase(end)} with ${length}${othersNote}`);
  }
  return result;
}

/**
 * repairBootCloseGaps for records that arrived after the boot repair ran: an
 * archive import's, or a service Rebuild from raw recreated. What it could not
 * repair (an attendance record unreadable, a save that failed) is tried again
 * at the next start: the once-per-install marker is taken back, and the boot
 * run is a no-op on every record it already repaired.
 */
export async function repairArrivedRecords(keys: ReadonlySet<string>): Promise<GapRepairResult> {
  const retryAtNextStart = async () => {
    await historyRepairsStore.update((done) => {
      const rest = { ...done };
      delete rest[OLD_BOOT_CLOSE_REPAIR];
      return rest;
    });
    console.log("[reconcile] what could not be repaired is tried again when the server next starts");
  };
  let result: GapRepairResult;
  try {
    result = await repairBootCloseGaps(keys);
  } catch (err) {
    await retryAtNextStart();
    throw err;
  }
  if (result.waiting || result.failed.length) await retryAtNextStart();
  return result;
}

/**
 * repairBootCloseGaps over every record, once per install, at boot: the records
 * a close before v1.29.0 wrote.
 *
 * The marker saves a record it could not measure from being looked at and
 * logged again on every boot. It is set only when every record was read and
 * every save landed, so a failure is tried again next boot. A marker that cannot
 * be written throws: the repair then runs again next boot.
 */
async function repairOldBootCloses(): Promise<GapRepairResult | null> {
  if ((await historyRepairsStore.load())[OLD_BOOT_CLOSE_REPAIR]) return null;
  const result = await repairBootCloseGaps();
  if (result.waiting) return result;
  const unread = splHistoryStore.unreadable() ?? serviceTimelineStore.unreadable();
  if (unread) {
    console.log(`[reconcile] the repair of records an older version closed at boot runs again next boot: ${scrub(unread.message)}`);
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
    const repair = await repairOldBootCloses();
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
      stampItemEnds(itemsOf(rec), end.iso);
      rec.endedAt = end.iso;
      await splHistoryStore.upsert(rec);
      closed++;
    }
  }
  for (const rec of await serviceTimelineStore.list()) {
    if (rec.endedAt == null) {
      const end = endFor(rec, witness);
      if (end.measured) {
        closeTimelineItems(itemsOf(rec), end.iso);
      } else if (stampItemEnds(itemsOf(rec), end.iso) > 0) {
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
