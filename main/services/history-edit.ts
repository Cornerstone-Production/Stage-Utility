// history-edit.ts — Post-hoc correction of finalized service records. Recordings
// are otherwise write-once; these let an operator fix a bad capture (e.g. a service
// that kept "recording" through a parked Stream Buffer) instead of only deleting it.
//
// All three records (timeline, attendance, SPL) share a serviceKey, so editing the
// service window applies to each: the raw samples are kept, so aggregates re-derive.

import type { ServiceAttendance } from "../types/stage.js";
import { sampleArchive } from "./archive/sample-archive.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { attendanceStore } from "./attendance-store.js";
import { splHistoryStore } from "./spl-history-store.js";
import { broadcast } from "./broadcaster.js";
import { attendanceRecorder } from "./attendance-recorder.js";
import { splRecorder } from "./spl-recorder.js";
import { serviceTimelineRecorder } from "./service-timeline-recorder.js";

/** Every recorder that holds a copy of a service record. Named once: each of the
 *  three has to be released before any edit here, and doing it per-store was how
 *  two of these paths ended up without a forget() at all. */
const RECORDERS = [serviceTimelineRecorder, attendanceRecorder, splRecorder];

/** Thrown past the route handlers so remote-server can answer 409. */
export class ServiceIsLiveError extends Error {
  readonly status = 409;
  constructor(action: string) {
    super(`That service is recording right now — it cannot be ${action} until it ends.`);
    this.name = "ServiceIsLiveError";
  }
}

/**
 * Refuse to touch a record the recorders are still writing.
 *
 * Every function in this file rewrites a stored record, and a recorder holding
 * the same record will persist its own copy over the result on its next
 * debounce. forget() releases that copy, but for a LIVE service it only moves
 * the problem: the next tick re-establishes the same key and starts a fresh,
 * empty record seconds later — a delete that appeared to work and then came
 * back, looking to the operator like a bad capture rather than their own click.
 *
 * There is no ordering that wins this. The operator's edit and the live tick are
 * both correct about the record they hold. So the answer is not to race: while
 * the service is running, its history is not editable. Correcting a recording
 * is a post-hoc repair — that is what this whole file is for — and the service
 * ending is minutes away.
 */
export function assertNotLive(serviceKey: string, action: string): void {
  if (RECORDERS.some((r) => r.isRecording(serviceKey))) throw new ServiceIsLiveError(action);
}

/** Release every recorder's copy of these keys. Called BEFORE the first awaited
 *  write, never after: a debounce that fires mid-await writes the pre-edit
 *  record back over the one just saved. */
function forgetAll(...serviceKeys: string[]): void {
  for (const r of RECORDERS) for (const k of serviceKeys) r.forget(k);
}

/**
 * Delete a service recording — all three records, in one place.
 *
 * The three stores were deleted by three separate routes, and the History panel
 * called exactly one of them, so "Delete recording" removed the timeline and
 * left the SPL and attendance records behind: invisible, undeletable through
 * the UI, and counted by every aggregate that reads those stores. The two
 * settings panels that called the other two routes were removed as unreachable
 * dead code, which is what took the last callers with them.
 *
 * The raw archive is deliberately NOT removed. It is the source of truth the
 * records are derived from, a delete of it cannot be undone, and nothing reads
 * it for a service with no record. Removing an operator's raw samples is a
 * bigger decision than "delete this recording" asks for.
 */
export async function deleteServiceRecords(
  serviceKey: string,
): Promise<{ deleted: boolean; records: string[] }> {
  assertNotLive(serviceKey, "deleted");
  forgetAll(serviceKey);
  const gone = await Promise.all([
    serviceTimelineStore.delete(serviceKey),
    attendanceStore.delete(serviceKey),
    splHistoryStore.delete(serviceKey),
  ]);
  const records = ["timeline", "attendance", "spl"].filter((_, i) => gone[i]);
  return { deleted: records.length > 0, records };
}

/** Re-derive attendance aggregates from the (possibly trimmed) sample series. Note:
 *  totalAttendance is a raw daily counter we can't reconstruct from baselined
 *  samples, so it's left as-is. */
function recomputeAttendance(att: ServiceAttendance): void {
  const s = att.samples;
  // Per-service attendance = value − first sample (the count when this window began),
  // so a service not reset off the prior one reads its own count; on a trim, the new
  // first in-window sample re-baselines automatically.
  const base = s.length ? s[0].attendance : 0;
  // attendanceBaseline is the RAW daily counter at this record's start — that is
  // what the recorder writes and what a merge needs to convert between two
  // records' frames. This used to assign `base`, an already-baselined value
  // (normally 0), without touching the samples: after any Recalculate, window
  // edit or earlier merge the field no longer meant what its writer meant, and a
  // later merge reading it as raw shifted the other record by a hundred people.
  // Advancing it by the same amount the samples are about to be re-based by keeps
  // raw = sample + baseline true.
  att.attendanceBaseline = (att.attendanceBaseline ?? 0) + base;
  if (base !== 0) for (const x of s) x.attendance -= base;
  // Samples are now expressed against this record's own start, so the aggregates
  // read them directly. (Clamped only against a negative left by a hand-edited
  // window.)
  const perSvc = (v: number) => Math.max(0, v);
  // Peak/Lowest/Last reflect the SERVICE, not the pre-service arrival ramp or the
  // post-service emptying room — those tagged samples still draw the curve but must
  // not drag the "floor" or "last" toward an empty room. Fall back to all samples if
  // a record has no in-service samples at all (shouldn't happen in practice).
  const svc = s.filter((x) => !x.phase);
  const stat = svc.length ? svc : s;
  att.peakAttendance = stat.reduce((m, x) => Math.max(m, perSvc(x.attendance)), 0);
  att.peakOccupancy = stat.reduce((m, x) => Math.max(m, x.occupancy), 0);
  att.minOccupancy = stat.length ? stat.reduce((m, x) => Math.min(m, x.occupancy), stat[0].occupancy) : null;
  att.lastAttendance = stat.length ? perSvc(stat[stat.length - 1].attendance) : 0;
  att.lastOccupancy = stat.length ? stat[stat.length - 1].occupancy : 0;
}

/** Adjust a service's start/end window across all three records: trim the timeline's
 *  trailing items, drop attendance samples / SPL items outside the window, and
 *  recompute derived values. Any of start/end may be omitted to leave it unchanged. */
export async function editServiceWindow(
  serviceKey: string,
  opts: { startedAt?: string; endedAt?: string },
): Promise<void> {
  assertNotLive(serviceKey, "re-windowed");
  // The delete and merge paths were given this when a record was found
  // resurrecting itself; the two edit paths were missed, so a trimmed window
  // survived only until the recorder's next debounce wrote the untrimmed copy
  // back over it.
  forgetAll(serviceKey);

  const startMs = opts.startedAt ? Date.parse(opts.startedAt) : null;
  const endMs = opts.endedAt ? Date.parse(opts.endedAt) : null;
  const inWindow = (iso: string | null | undefined): boolean => {
    if (!iso) return true;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return true;
    return (startMs == null || t >= startMs) && (endMs == null || t <= endMs);
  };

  const tl = await serviceTimelineStore.get(serviceKey);
  if (tl) {
    if (opts.startedAt) tl.startedAt = opts.startedAt;
    if (opts.endedAt) tl.endedAt = opts.endedAt;
    if (endMs != null) {
      tl.items = tl.items.filter((it) => Date.parse(it.startedAt) <= endMs); // drop items starting after the end
      for (const it of tl.items) {
        if (it.endedAt == null || Date.parse(it.endedAt) > endMs) {
          it.endedAt = new Date(endMs).toISOString();
          const s = Date.parse(it.startedAt);
          if (Number.isFinite(s)) it.actualDurationSec = Math.max(0, Math.round((endMs - s) / 1000));
        }
      }
    }
    await serviceTimelineStore.upsert(tl);
    broadcast("service-timeline:history", tl);
  }

  const att = await attendanceStore.get(serviceKey);
  if (att) {
    if (opts.startedAt) att.startedAt = opts.startedAt;
    if (opts.endedAt) att.endedAt = opts.endedAt;
    att.samples = att.samples.filter((s) => inWindow(s.t));
    recomputeAttendance(att);
    await attendanceStore.upsert(att);
    broadcast("attendance:history", att);
  }

  const spl = await splHistoryStore.get(serviceKey);
  if (spl) {
    if (opts.startedAt) spl.startedAt = opts.startedAt;
    if (opts.endedAt) {
      spl.endedAt = opts.endedAt;
      spl.items = spl.items.filter((it) => (endMs == null ? true : Date.parse(it.startedAt) <= endMs));
    }
    await splHistoryStore.upsert(spl);
    broadcast("spl:history", spl);
  }
}

/** Set a per-item override for whether it counts toward the service timers (wins
 *  over the auto buffer/pre-service default). */
export async function setItemCounted(serviceKey: string, itemId: string, counted: boolean): Promise<void> {
  assertNotLive(serviceKey, "edited");
  forgetAll(serviceKey); // see editServiceWindow
  const tl = await serviceTimelineStore.get(serviceKey);
  if (!tl) return;
  const it = tl.items.find((x) => x.itemId === itemId);
  if (!it) return;
  it.counted = counted;
  await serviceTimelineStore.upsert(tl);
  broadcast("service-timeline:history", tl);
}

/** Re-derive attendance aggregates from the current samples (no window change) —
 *  for when the stored peak/min look stale but the samples are fine. */
export async function recalcAttendance(serviceKey: string): Promise<void> {
  assertNotLive(serviceKey, "recalculated");
  forgetAll(serviceKey); // see editServiceWindow
  const att = await attendanceStore.get(serviceKey);
  if (!att) return;
  recomputeAttendance(att);
  await attendanceStore.upsert(att);
  broadcast("attendance:history", att);
}

/**
 * A service's archive directory is named by key AND date, so moving its raw rows
 * needs both. The date is not in the key — read it from whichever record still
 * carries it, and skip the move entirely if no record names one, because a
 * guessed date would point at a directory belonging to nothing.
 */
async function serviceDateOf(serviceKey: string): Promise<string | null> {
  const [tl, att, spl] = await Promise.all([
    serviceTimelineStore.get(serviceKey),
    attendanceStore.get(serviceKey),
    splHistoryStore.get(serviceKey),
  ]);
  return tl?.serviceDate ?? att?.serviceDate ?? spl?.serviceDate ?? null;
}

/** Move the source's raw rows into the target's archive, and say what moved.
 *  Logged rather than silent: this rewrites the source of truth and deletes a
 *  directory, and the operator's only other evidence is the merged record. */
async function mergeArchives(sourceKey: string, targetKey: string): Promise<void> {
  const [sourceDate, targetDate] = await Promise.all([
    serviceDateOf(sourceKey),
    serviceDateOf(targetKey),
  ]);
  if (!sourceDate || !targetDate) {
    console.warn(
      `[history-edit] merge ${sourceKey} -> ${targetKey}: no service date on one side, ` +
        "leaving the raw archive alone. The merged record will not survive a rebuild.",
    );
    return;
  }
  const moved = await sampleArchive.mergeInto(
    { serviceKey: sourceKey, serviceDate: sourceDate },
    { serviceKey: targetKey, serviceDate: targetDate },
  );
  const summary = Object.entries(moved)
    .map(([base, n]) => `${n} ${base}`)
    .join(", ");
  console.log(
    `[history-edit] merge ${sourceKey} -> ${targetKey}: moved ${summary || "no rows"} ` +
      `into ${targetDate}; removed the source archive.`,
  );
}

/**
 * Merge one service recording (source) INTO another (target) across all three
 * stores, then delete the source. Fixes a mis-split service (e.g. a run that
 * overran its planned end and rolled the tail into the next occurrence's record):
 * merge the wrong record back into the right one. Items are matched by itemId so a
 * duplicated boundary item isn't doubled; attendance samples are concatenated and
 * aggregates re-derived; the target window extends to cover both.
 */
export async function mergeServiceRecords(sourceKey: string, targetKey: string): Promise<void> {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  assertNotLive(sourceKey, "merged");
  assertNotLive(targetKey, "merged");

  // Released up front, for both keys, before the first awaited write. This used
  // to sit after each store's upsert, which left a window where the recorder's
  // pending debounce could land on the merged record and revert it.
  forgetAll(sourceKey, targetKey);

  // ── Raw samples ──
  // First, because the archive is what a rebuild reads: forget(targetKey) above
  // is precisely what makes the next SPL resume rebuild from these rows, and a
  // rebuild against the target's own directory discards everything merged in.
  // Moving them first also means a failure here aborts before either record is
  // touched, rather than leaving a merged record over an unmerged archive.
  await mergeArchives(sourceKey, targetKey);

  // ── Timeline ──
  const [srcTl, tgtTl] = await Promise.all([
    serviceTimelineStore.get(sourceKey),
    serviceTimelineStore.get(targetKey),
  ]);
  if (srcTl && tgtTl) {
    const have = new Set(tgtTl.items.map((i) => i.itemId));
    for (const it of srcTl.items) if (!have.has(it.itemId)) tgtTl.items.push(it);
    tgtTl.items.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    tgtTl.items.forEach((it, i) => { it.sequence = i; });
    const ends = tgtTl.items.map((i) => (i.endedAt ? Date.parse(i.endedAt) : NaN)).filter(Number.isFinite);
    if (ends.length) tgtTl.endedAt = new Date(Math.max(...ends)).toISOString();
    await serviceTimelineStore.upsert(tgtTl);
    await serviceTimelineStore.delete(sourceKey);
    broadcast("service-timeline:history", tgtTl);
  }

  // ── Attendance ──
  const [srcAt, tgtAt] = await Promise.all([
    attendanceStore.get(sourceKey),
    attendanceStore.get(targetKey),
  ]);
  if (srcAt && tgtAt) {
    // Each record's samples are stored as raw-minus-its-OWN-baseline, so the two
    // series are in different frames: the tail record baselined at its own first
    // reading and starts near zero while the target's end near its full count.
    // Concatenating them raw put a cliff to zero at the seam and dragged the
    // service average and lastAttendance down with it — the repair tool producing
    // a worse record than the split it was invoked to fix.
    //
    // Shifting the source into the target's frame is exact: both baselines are the
    // raw daily counter at their own start, so their difference is the offset.
    // Read before recomputeAttendance, which rewrites attendanceBaseline.
    // Shift BOTH into the earlier of the two baselines rather than into the
    // target's. The merge target is not necessarily the later record — the panel
    // offers every same-day recording, and merging a spurious leading fragment
    // INTO the main record is the natural repair — so shifting the source into
    // the target's frame produced a negative offset, and clamping that at zero
    // silently flattened the fragment's attendees to nothing. A common floor
    // makes both shifts non-negative, so no clamp is needed and a bad offset
    // would surface as a wrong number rather than as deleted data.
    const srcBase = srcAt.attendanceBaseline;
    const tgtBase = tgtAt.attendanceBaseline;
    const shift =
      srcBase != null && tgtBase != null
        ? { base: Math.min(srcBase, tgtBase), src: srcBase - Math.min(srcBase, tgtBase), tgt: tgtBase - Math.min(srcBase, tgtBase) }
        : { base: tgtBase ?? srcBase ?? 0, src: 0, tgt: 0 };
    const bump = (list: typeof srcAt.samples, by: number) =>
      by === 0 ? list : list.map((s) => ({ ...s, attendance: s.attendance + by }));
    tgtAt.attendanceBaseline = shift.base;
    tgtAt.samples = [...bump(tgtAt.samples, shift.tgt), ...bump(srcAt.samples, shift.src)].sort(
      (a, b) => Date.parse(a.t) - Date.parse(b.t),
    );
    if (srcAt.endedAt && (!tgtAt.endedAt || Date.parse(srcAt.endedAt) > Date.parse(tgtAt.endedAt))) {
      tgtAt.endedAt = srcAt.endedAt;
    }
    tgtAt.totalAttendance = Math.max(tgtAt.totalAttendance, srcAt.totalAttendance);
    recomputeAttendance(tgtAt);
    await attendanceStore.upsert(tgtAt);
    await attendanceStore.delete(sourceKey);
    broadcast("attendance:history", tgtAt);
  }

  // ── SPL ──
  const [srcSpl, tgtSpl] = await Promise.all([
    splHistoryStore.get(sourceKey),
    splHistoryStore.get(targetKey),
  ]);
  if (srcSpl && tgtSpl) {
    const have = new Set(tgtSpl.items.map((i) => i.itemId));
    for (const it of srcSpl.items) if (!have.has(it.itemId)) tgtSpl.items.push(it);
    tgtSpl.items.forEach((it, i) => { it.sequence = i; });
    if (srcSpl.endedAt && (!tgtSpl.endedAt || Date.parse(srcSpl.endedAt) > Date.parse(tgtSpl.endedAt))) {
      tgtSpl.endedAt = srcSpl.endedAt;
    }
    await splHistoryStore.upsert(tgtSpl);
    await splHistoryStore.delete(sourceKey);
    broadcast("spl:history", tgtSpl);
  }
}
