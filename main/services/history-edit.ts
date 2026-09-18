// history-edit.ts — Post-hoc correction of finalized service records. Recordings
// are otherwise write-once; these let an operator fix a bad capture (e.g. a service
// that kept "recording" through a parked Stream Buffer) instead of only deleting it.
//
// All three records (timeline, attendance, SPL) share a serviceKey, so editing the
// service window applies to each: the raw samples are kept, so aggregates re-derive.

import type { AttendanceSample } from "../types/history.js";
import type { ServiceAttendance, ServiceItemTimeEdit, ServiceTimeline } from "../types/stage.js";
import { serviceDirPath } from "./archive/archive-paths.js";
import { readArchiveRows } from "./archive/archive-rows.js";
import { mergeItemRuns } from "./archive/merge-records.js";
import { rebuildSplRecord, rebuildTimelineRecord } from "./archive/rebuild.js";
import { sampleArchive } from "./archive/sample-archive.js";
import { errorMessage } from "./errors.js";
import { scrub } from "./scrub.js";
import { serviceTimelineStore } from "./service-timeline-store.js";
import { attendanceStore } from "./attendance-store.js";
import { settingsStore, DEFAULT_TAPER_WINDOW } from "./settings-store.js";
import { splHistoryStore } from "./spl-history-store.js";
import { broadcast } from "./broadcaster.js";
import { bindItemTimeEdits, broadcastTimeline, overlaidTimeline, rekeyItemTimeEdits } from "./history-item-times.js";
import { clockOf } from "./app-timezone.js";
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
  const stores = [
    ["timeline", serviceTimelineStore],
    ["attendance", attendanceStore],
    ["spl", splHistoryStore],
  ] as const;
  const gone = await Promise.all(stores.map(([, store]) => store.delete(serviceKey)));
  const records = stores.filter((_, i) => gone[i]).map(([name]) => name as string);
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
/** The ramp/taper windows the recorder samples with, in ms. */
async function taperMs(): Promise<{ pre: number; post: number }> {
  const tw = (await settingsStore.get()).taperWindow ?? DEFAULT_TAPER_WINDOW;
  return { pre: Math.max(0, tw.preMin) * 60_000, post: Math.max(0, tw.postMin) * 60_000 };
}

/**
 * Re-window a record's samples WITHOUT throwing the ramp and taper away.
 *
 * A sample is an observation; the window is metadata about it. The arrival ramp
 * and the emptying-room taper live OUTSIDE the window on purpose — the recorder
 * tags them `pre`/`post` for exactly that reason, and `recomputeAttendance`
 * already keeps tagged samples out of Peak/Lowest/Last while leaving them in
 * the curve.
 *
 * This used to be a filter to the window itself, followed by an upsert. So the
 * first time anyone corrected an end time by a minute, every ramp and taper
 * sample was deleted from the stored record — the fade they were looking at
 * vanished, permanently, as a side effect of a timing fix.
 *
 * What survives is anything inside the ramp/taper windows, re-tagged against
 * the NEW window. A genuine trim still drops what falls outside those, which is
 * what trimming a bad capture is for.
 */
function rewindowSamples(att: ServiceAttendance, taper: { pre: number; post: number }): AttendanceSample[] {
  const start = Date.parse(att.startedAt);
  const end = att.endedAt ? Date.parse(att.endedAt) : Number.NaN;
  const lo = Number.isFinite(start) ? start - taper.pre : -Infinity;
  const hi = Number.isFinite(end) ? end + taper.post : Infinity;

  const out: AttendanceSample[] = [];
  for (const s of att.samples) {
    const t = Date.parse(s.t);
    // An unparseable stamp is not evidence the sample is unwanted, and dropping
    // it would be the same silent deletion in a smaller coat.
    if (!Number.isFinite(t)) { out.push(s); continue; }
    if (t < lo || t > hi) continue;
    const phase = Number.isFinite(start) && t < start ? "pre"
      : Number.isFinite(end) && t > end ? "post"
      : undefined;
    // Rebuilt rather than mutated: phase has to be ABSENT in-service, and
    // assigning undefined leaves the key present for anything reading `in`.
    const next: AttendanceSample = { t: s.t, attendance: s.attendance, occupancy: s.occupancy };
    if (phase) next.phase = phase;
    out.push(next);
  }
  return out;
}

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

  const endMs = opts.endedAt ? Date.parse(opts.endedAt) : null;

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
    broadcastTimeline(tl);
  }

  const att = await attendanceStore.get(serviceKey);
  if (att) {
    if (opts.startedAt) att.startedAt = opts.startedAt;
    if (opts.endedAt) att.endedAt = opts.endedAt;
    att.samples = rewindowSamples(att, await taperMs());
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
 *  over the auto buffer/pre-service default).
 *
 *  A plan item can appear in a record more than once — reprised, or run again in
 *  a second service that landed here before the occurrence split caught up. The
 *  override is a statement about the PLAN item, so it applies to every entry for
 *  that id; `find` would have set it on one and left the row the operator clicked
 *  unchanged. */
export async function setItemCounted(serviceKey: string, itemId: string, counted: boolean): Promise<void> {
  assertNotLive(serviceKey, "edited");
  forgetAll(serviceKey); // see editServiceWindow
  const tl = await serviceTimelineStore.get(serviceKey);
  if (!tl) return;
  const hits = tl.items.filter((x) => x.itemId === itemId);
  if (hits.length === 0) return;
  // Marked as the OPERATOR's, not the recorder's. The recorder writes `counted:
  // false` by itself for an item carried over from an earlier session, and with
  // one unmarked field a rebuild could not tell the two apart — so it spread an
  // observation about one run onto every run of the item.
  for (const it of hits) {
    it.counted = counted;
    it.countedByOperator = true;
  }
  await serviceTimelineStore.upsert(tl);
  broadcastTimeline(tl);
}

/** A correction the record itself refuses. 400, not 500: the request was
 *  well-formed and the operator is being told what is wrong with it. */
export class ItemTimeEditError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ItemTimeEditError";
  }
}

/** "20:15:00 → 20:26:22", or "20:15:00 → (open)" for an item still running. */
function span(startedAt: string, endedAt: string | null): string {
  const s = Date.parse(startedAt);
  const e = endedAt ? Date.parse(endedAt) : NaN;
  return `${Number.isFinite(s) ? clockOf(s) : "?"}–${Number.isFinite(e) ? clockOf(e) : "(open)"}`;
}

/**
 * Correct ONE run of ONE item's recorded start and/or end.
 *
 * `null` for a field clears that override; clearing both removes the correction
 * entirely and the row goes back to what the recorder saw. The recorded stamps
 * are never touched — see history-item-times.ts for why this is an overlay and
 * not a rewrite.
 *
 * Unlike setItemCounted, this is keyed by (itemId, sequence) rather than itemId
 * alone. `counted` is a statement about the PLAN item and applies to every run
 * of it; a timing is a statement about ONE run, and a reprise that genuinely ran
 * nine minutes must not be shortened because the first run was mis-recorded.
 */
export async function setItemTimes(
  serviceKey: string,
  itemId: string,
  sequence: number,
  times: { startedAt?: string | null; endedAt?: string | null },
): Promise<ServiceTimeline> {
  assertNotLive(serviceKey, "edited");
  forgetAll(serviceKey); // see editServiceWindow
  const tl = await serviceTimelineStore.get(serviceKey);
  if (!tl) throw new ItemTimeEditError(`No recording found for "${serviceKey}".`);
  const item = tl.items.find((x) => x.itemId === itemId && x.sequence === sequence);
  if (!item) {
    throw new ItemTimeEditError(
      "That item is no longer in this recording — reload the service and try again.",
    );
  }

  // A field the caller did not mention keeps whatever override it already had;
  // an explicit null clears it. Distinguishing "absent" from "null" is what lets
  // the UI save one field without silently dropping the other.
  const prior = (tl.itemTimeEdits ?? []).find((e) => e.itemId === itemId && e.sequence === sequence);
  const startedAt = "startedAt" in times ? (times.startedAt ?? undefined) : prior?.startedAt;
  const endedAt = "endedAt" in times ? (times.endedAt ?? undefined) : prior?.endedAt;
  for (const [label, v] of [["start", startedAt], ["end", endedAt]] as const) {
    if (v != null && !Number.isFinite(Date.parse(v))) {
      throw new ItemTimeEditError(`That ${label} time is not a time I can read.`);
    }
  }

  const effStart = startedAt ?? item.startedAt;
  const effEnd = endedAt ?? item.endedAt;
  if (effEnd != null && Date.parse(effEnd) <= Date.parse(effStart)) {
    throw new ItemTimeEditError("The end has to come after the start.");
  }
  // Inside the recording's own window. An item timed outside it would be invisible
  // in half the readouts and would make the service's Actual disagree with its
  // own start and end — if the window is wrong, that is what Edit times fixes
  // first, and saying so is more use than accepting the number.
  const winStart = Date.parse(tl.startedAt);
  const winEnd = tl.endedAt ? Date.parse(tl.endedAt) : Infinity;
  for (const t of [effStart, effEnd]) {
    if (t == null) continue;
    const ms = Date.parse(t);
    if (ms < winStart || ms > winEnd) {
      throw new ItemTimeEditError(
        `That is outside the recording's own window (${span(tl.startedAt, tl.endedAt)}). ` +
          "Fix the service start and end first, then the item.",
      );
    }
  }

  const rest = (tl.itemTimeEdits ?? []).filter((e) => !(e.itemId === itemId && e.sequence === sequence));
  const cleared = startedAt === undefined && endedAt === undefined;
  if (!cleared) {
    const edit: ServiceItemTimeEdit = { itemId, sequence, editedAt: new Date().toISOString() };
    if (startedAt !== undefined) edit.startedAt = startedAt;
    if (endedAt !== undefined) edit.endedAt = endedAt;
    rest.push(edit);
  }
  if (rest.length) tl.itemTimeEdits = rest;
  else delete tl.itemTimeEdits; // absent, not an empty array, so an untouched record stays untouched

  await serviceTimelineStore.upsert(tl);
  const out = overlaidTimeline(tl);
  broadcastTimeline(tl);
  console.log(
    `[history] ${scrub(serviceKey)}: "${scrub(item.title)}" times ` +
      `${cleared ? "reset to the recording" : "edited"} by operator ` +
      `(${span(item.startedAt, item.endedAt)} → ${span(effStart, effEnd)})`,
  );
  return out;
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
 * One record's share of a rebuild.
 *
 * `rebuilt` is the whole point. Reporting a count alone made a record the raw
 * layer had NOTHING for indistinguishable from one that had just been derived:
 * a service whose archive directory is missing answered 200 and told the
 * operator "Rebuilt: 12 items" about the twelve items it had left exactly as
 * they were. A count is what the record holds; `rebuilt` is whether this run
 * put it there.
 */
export interface RebuiltRecord {
  /** True when the raw layer supplied these numbers; false = left as it was. */
  rebuilt: boolean;
  /** What the record holds afterwards. For attendance this counts SAMPLES —
   *  one field name across the three so the shape is uniform. */
  items: number;
  /** True when this store has no record for the key at all. */
  missing: boolean;
}

/** What a rebuild did, per record. Reported rather than summed: this rewrites
 *  the source of truth, and "it worked" is not evidence. */
export interface RebuildOutcome {
  timeline: RebuiltRecord;
  spl: RebuiltRecord;
  attendance: RebuiltRecord;
  /** Records that were derived but whose write failed AFTER another record's
   *  write had already landed — see rebuildServiceRecords. Empty is the normal
   *  case; a non-empty list means the operator is looking at a half-rebuilt
   *  service and needs to know which half. */
  failed: string[];
}

const NO_RECORD: RebuiltRecord = { rebuilt: false, items: 0, missing: true };

/** Nothing in the raw layer to rebuild this service from. A refusal, not a
 *  fault: the request was well-formed and the server is fine — there is simply
 *  no evidence to re-derive from, and pretending otherwise is the bug this
 *  replaced. 409, like the live-service refusal. */
export class NoRawRowsError extends Error {
  readonly status = 409;
  constructor() {
    super("No raw rows exist for this recording — there is nothing to rebuild it from.");
    this.name = "NoRawRowsError";
  }
}

/**
 * A rebuild that changed nothing because it could not.
 *
 * Deliberately carries NO detail from the underlying failure. A filesystem
 * error names an absolute path, this message reaches a LAN-visible page, and
 * the operator cannot act on the path anyway. The real reason is on the tagged
 * log line the thrower writes; `cause` keeps it for a stack trace.
 */
export class RebuildFailedError extends Error {
  constructor(reason: string) {
    super("That recording could not be rebuilt, and nothing was changed. The log says why.", { cause: reason });
    this.name = "RebuildFailedError";
  }
}

/**
 * Recompute all three of a service's summaries from its raw rows.
 *
 * The raw layer is append-only truth and every summary must be derivable from
 * it by the app. Two of the three already were — SPL rebuilds from `spl.csv` on
 * every restart, attendance re-derives from its own samples — but the timing
 * record was only ever written forward, so when a recorder bug corrupted one on
 * 18 Sep 2026 while `events.csv` stayed perfect, the repair had to be done by
 * hand. This is that repair, in the app.
 *
 * Hand edits to times do not survive it: an edited window, a trimmed tail and a
 * corrected end are all statements the raw rows know nothing about. The `counted`
 * overrides DO survive, because rebuildTimelineRecord carries them.
 *
 * Reports what it DERIVED, per record, rather than what each record holds. A
 * service with no archive directory used to answer 200 with the counts of the
 * records it had not touched, so the operator was told "Rebuilt: 12 items"
 * about twelve items nothing had looked at. Now each record says whether the
 * raw layer supplied it, nothing derivable at all is a 409, and a partial
 * result names its halves.
 *
 * Throws rather than reporting a partial success where nothing landed. A
 * rebuild that silently wrote nothing would leave the operator looking at the
 * same bad record believing it had been repaired.
 */
export async function rebuildServiceRecords(serviceKey: string): Promise<RebuildOutcome> {
  assertNotLive(serviceKey, "rebuilt");
  forgetAll(serviceKey); // see editServiceWindow

  const outcome: RebuildOutcome = {
    timeline: { ...NO_RECORD },
    spl: { ...NO_RECORD },
    attendance: { ...NO_RECORD },
    failed: [],
  };

  // ── Derive everything FIRST, write nothing ──
  //
  // Interleaving the two meant a failure part-way through left the service
  // half-rebuilt with no record of which half: the timing record derived from
  // this evening's rows, the SPL record still the corrupted one, and a 500 that
  // said neither. Deriving first makes the common failure — a bad row, an
  // unreadable CSV — cost nothing at all, because it happens before the first
  // write.
  const pending: { name: LegName; write: () => Promise<void> }[] = [];
  try {
    const serviceDate = await serviceDateOf(serviceKey);
    // Not the same refusal as "no raw rows": serviceDateOf reads all three
    // stores, so a null date means this key names no recording at all. That is
    // the caller naming something that does not exist, and stays a 500 — the
    // 409 below is about a recording that DOES exist and has nothing behind it.
    if (!serviceDate) {
      throw new Error(`no record for "${serviceKey}" names a service date, so its raw rows cannot be located`);
    }
    const dir = serviceDirPath(serviceKey, serviceDate);

    // Timeline, from events.csv.
    const tl = await serviceTimelineStore.get(serviceKey);
    if (tl) {
      const rows = await readArchiveRows(dir, "events");
      if (rows && rows.length > 0) {
        const next = rebuildTimelineRecord(tl, rows);
        outcome.timeline = { rebuilt: true, items: next.items.length, missing: false };
        pending.push({
          name: "timeline",
          write: async () => {
            await serviceTimelineStore.upsert(next);
            broadcastTimeline(next);
          },
        });
      } else {
        // Left exactly as it was. The count is what it still holds, and
        // `rebuilt: false` is what stops that count reading as an achievement.
        outcome.timeline = { rebuilt: false, items: tl.items.length, missing: false };
      }
    }

    // SPL, from spl.csv.
    const spl = await splHistoryStore.get(serviceKey);
    if (spl) {
      const next = await rebuildSplRecord(spl);
      outcome.spl = { rebuilt: next != null, items: (next ?? spl).items.length, missing: false };
      if (next) {
        pending.push({
          name: "spl",
          write: async () => {
            await splHistoryStore.upsert(next);
            broadcast("spl:history", next);
          },
        });
      }
    }

    // Attendance, from its own stored samples. Not from attendance.csv: the
    // stored samples are already the down-sampled series the record is defined
    // over, and recomputeAttendance is the same pass Recalculate runs.
    // Re-deriving the series itself is a different operation with a different
    // answer, and is not what this offers. It always re-derives when the record
    // exists, so it is `rebuilt` whenever it is here.
    const att = await attendanceStore.get(serviceKey);
    if (att) {
      // CLONED before recomputing. The store hands back the instance it caches,
      // and recomputeAttendance mutates in place — so a failed write left every
      // reader in this process looking at re-based samples that were never
      // saved, and the next restart silently undid them.
      const next: ServiceAttendance = structuredClone(att);
      recomputeAttendance(next);
      outcome.attendance = { rebuilt: true, items: next.samples.length, missing: false };
      pending.push({
        name: "attendance",
        write: async () => {
          await attendanceStore.upsert(next);
          broadcast("attendance:history", next);
        },
      });
    }
  } catch (err) {
    // Nothing has been written, so this costs the operator nothing but the
    // answer. The REASON is logged, never returned: a raw filesystem error
    // names a path, and this response reaches a LAN-visible page.
    console.warn(`[history] rebuild of ${scrub(serviceKey)} failed: ${scrub(errorMessage(err))}`);
    throw new RebuildFailedError(errorMessage(err));
  }

  if (pending.length === 0) {
    console.log(`[history] rebuild of ${scrub(serviceKey)}: no raw rows, nothing changed`);
    throw new NoRawRowsError();
  }

  // ── Now write ──
  //
  // A write that fails before ANY has landed is still "nothing changed", and
  // says so with a throw. One that fails after another landed cannot be undone,
  // so it is reported instead: the operator is looking at a half-rebuilt
  // service and the answer has to name which half. See CLAUDE.md — a function
  // that can partially fail returns what failed.
  let landed = 0;
  for (const leg of pending) {
    try {
      await leg.write();
      landed += 1;
    } catch (err) {
      console.warn(
        `[history] rebuild of ${scrub(serviceKey)}: could not write the ${scrub(leg.name)} record: ${scrub(errorMessage(err))}`,
      );
      outcome[leg.name].rebuilt = false;
      if (landed === 0) throw new RebuildFailedError(errorMessage(err));
      outcome.failed.push(leg.name);
    }
  }

  // Written out at both call sites rather than through a `line` variable: the
  // log-injection scan reads the ARGUMENT of a console call, and a variable it
  // cannot follow is exactly the shape that lets an unscrubbed value through.
  if (outcome.failed.length) {
    console.warn(`[history] rebuilt ${scrub(serviceKey)} from raw: ${scrub(summarise(outcome))}`);
  } else {
    console.log(`[history] rebuilt ${scrub(serviceKey)} from raw: ${scrub(summarise(outcome))}`);
  }
  return outcome;
}

/** The three legs, with the noun each counts. Named once so the log line and
 *  the outcome cannot drift into describing different things. */
const LEGS = [
  ["timeline", "timeline items"],
  ["spl", "SPL items"],
  ["attendance", "attendance samples"],
] as const;

type LegName = (typeof LEGS)[number][0];

/** "12 timeline items, 24 SPL items; left alone: attendance" — what was derived
 *  and, explicitly, what was not. The half that was missing is the half an
 *  operator debugging this on a Sunday needs. */
function summarise(outcome: RebuildOutcome): string {
  const rebuilt = LEGS.filter(([n]) => outcome[n].rebuilt).map(([n, noun]) => `${outcome[n].items} ${noun}`);
  const left = LEGS.filter(([n]) => !outcome[n].rebuilt && !outcome[n].missing).map(([, noun]) => noun);
  const parts = [rebuilt.join(", ") || "nothing"];
  if (left.length) parts.push(`left alone: ${left.join(", ")}`);
  if (outcome.failed.length) parts.push(`FAILED to write: ${outcome.failed.join(", ")}`);
  return parts.join("; ");
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

/**
 * The fields every recorder writes to say WHICH occurrence a record describes.
 * Identical across all three record types, so one shape re-keys any of them.
 */
type OccurrenceIdentity = Pick<
  ServiceTimeline,
  | "serviceKey"
  | "serviceTypeId"
  | "serviceTypeName"
  | "planId"
  | "planTitle"
  | "seriesTitle"
  | "serviceDate"
  | "serviceTimeId"
  | "serviceTimeStartsAt"
>;

/** Read an occurrence's identity from whichever store still holds a record. */
async function identityOf(serviceKey: string): Promise<OccurrenceIdentity | null> {
  const [tl, att, spl] = await Promise.all([
    serviceTimelineStore.get(serviceKey),
    attendanceStore.get(serviceKey),
    splHistoryStore.get(serviceKey),
  ]);
  const r = tl ?? att ?? spl;
  if (!r) return null;
  return {
    serviceKey: r.serviceKey,
    serviceTypeId: r.serviceTypeId,
    serviceTypeName: r.serviceTypeName,
    planId: r.planId,
    planTitle: r.planTitle,
    seriesTitle: r.seriesTitle,
    serviceDate: r.serviceDate,
    serviceTimeId: r.serviceTimeId,
    serviceTimeStartsAt: r.serviceTimeStartsAt,
  };
}

/**
 * Re-key a source-only record onto the target occurrence.
 *
 * The merge blocks below all required BOTH sides to exist. When only the source
 * had a record in a store — the attendance sensor was offline for the main
 * service but the fragment caught samples, or SPL was recorded on one side only
 * — that store was left untouched while the raw rows underneath it had already
 * been moved to the target's archive directory. The operator was told the merge
 * succeeded, the fragment stayed in the History list, and a rebuild of either
 * record produced wrong numbers.
 *
 * Adopting the target's identity is what "merge INTO" means when there is
 * nothing on the other side to merge with: the source's data, under the target's
 * name — which is also what the already-moved archive now describes.
 */
function adoptIdentity<T extends OccurrenceIdentity>(record: T, identity: OccurrenceIdentity): T {
  return { ...record, ...identity };
}

/** What a merge actually did, per store. Reported rather than assumed: this
 *  rewrites the source of truth, and "it worked" is not evidence. */
export interface MergeOutcome {
  /** Stores where both sides existed and were combined. */
  merged: string[];
  /** Stores where only the source had a record, re-keyed onto the target. */
  moved: string[];
  /** True when the raw sample archive was moved (false = no date on one side). */
  archivesMoved: boolean;
}

/** Move the source's raw rows into the target's archive, and say what moved.
 *  Logged rather than silent: this rewrites the source of truth and deletes a
 *  directory, and the operator's only other evidence is the merged record. */
async function mergeArchives(sourceKey: string, targetKey: string): Promise<boolean> {
  const [sourceDate, targetDate] = await Promise.all([
    serviceDateOf(sourceKey),
    serviceDateOf(targetKey),
  ]);
  if (!sourceDate || !targetDate) {
    console.warn(
      `[history-edit] merge ${scrub(sourceKey)} -> ${scrub(targetKey)}: no service date on one side, ` +
        "leaving the raw archive alone. The merged record will not survive a rebuild.",
    );
    return false;
  }
  const moved = await sampleArchive.mergeInto(
    { serviceKey: sourceKey, serviceDate: sourceDate },
    { serviceKey: targetKey, serviceDate: targetDate },
  );
  const summary = Object.entries(moved)
    .map(([base, n]) => `${n} ${base}`)
    .join(", ");
  console.log(
    `[history-edit] merge ${scrub(sourceKey)} -> ${scrub(targetKey)}: moved ${scrub(summary || "no rows")} ` +
      `into ${scrub(targetDate)}; removed the source archive.`,
  );
  return true;
}

/**
 * Merge one service recording (source) INTO another (target) across all three
 * stores, then delete the source. Fixes a mis-split service (e.g. a run that
 * overran its planned end and rolled the tail into the next occurrence's record):
 * merge the wrong record back into the right one. Items are matched by itemId so a
 * duplicated boundary item isn't doubled; attendance samples are concatenated and
 * aggregates re-derived; the target window extends to cover both.
 */
export async function mergeServiceRecords(sourceKey: string, targetKey: string): Promise<MergeOutcome> {
  const outcome: MergeOutcome = { merged: [], moved: [], archivesMoved: false };
  if (!sourceKey || !targetKey || sourceKey === targetKey) return outcome;
  assertNotLive(sourceKey, "merged");
  assertNotLive(targetKey, "merged");

  // Read the target's identity BEFORE anything moves. A store that holds a
  // source record but no target record needs it to re-key onto, and finding
  // that out after the archive had already been moved is how a record ended up
  // sitting over raw rows that no longer belonged to it.
  const targetIdentity = await identityOf(targetKey);
  if (!targetIdentity) {
    throw new Error(`Nothing to merge into: no record found for "${targetKey}".`);
  }

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
  outcome.archivesMoved = await mergeArchives(sourceKey, targetKey);

  // ── Timeline ──
  const [srcTl, tgtTl] = await Promise.all([
    serviceTimelineStore.get(sourceKey),
    serviceTimelineStore.get(targetKey),
  ]);
  if (srcTl && tgtTl) {
    // Item time corrections are keyed by (itemId, sequence) and this block
    // renumbers every sequence, so bind each side's edits to their ITEM OBJECTS
    // first and re-key from the new numbers after. mergeItemRuns returns the
    // references it was given, so identity is what survives the renumber.
    // Without this the operator's corrections would still be in the merged
    // record and would land, silently, on whichever rows took those numbers.
    const boundEdits = bindItemTimeEdits(tgtTl, srcTl);
    // By RUN, not by item id — see mergeItemRuns. Keyed on the id alone, a
    // source that ran an item twice contributed at most one of them.
    tgtTl.items = mergeItemRuns(tgtTl.items, srcTl.items);
    tgtTl.items.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    tgtTl.items.forEach((it, i) => { it.sequence = i; });
    const rekeyed = rekeyItemTimeEdits(boundEdits, tgtTl.items);
    if (rekeyed.length) tgtTl.itemTimeEdits = rekeyed;
    else delete tgtTl.itemTimeEdits;
    const ends = tgtTl.items.map((i) => (i.endedAt ? Date.parse(i.endedAt) : NaN)).filter(Number.isFinite);
    if (ends.length) tgtTl.endedAt = new Date(Math.max(...ends)).toISOString();
    await serviceTimelineStore.upsert(tgtTl);
    await serviceTimelineStore.delete(sourceKey);
    broadcastTimeline(tgtTl);
    outcome.merged.push("timeline");
  } else if (srcTl) {
    // Source-only: re-key rather than leave it behind over a moved archive.
    const moved = adoptIdentity(srcTl, targetIdentity);
    await serviceTimelineStore.upsert(moved);
    await serviceTimelineStore.delete(sourceKey);
    broadcastTimeline(moved);
    outcome.moved.push("timeline");
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
    outcome.merged.push("attendance");
  } else if (srcAt) {
    const moved = adoptIdentity(srcAt, targetIdentity);
    await attendanceStore.upsert(moved);
    await attendanceStore.delete(sourceKey);
    broadcast("attendance:history", moved);
    outcome.moved.push("attendance");
  }

  // ── SPL ──
  const [srcSpl, tgtSpl] = await Promise.all([
    splHistoryStore.get(sourceKey),
    splHistoryStore.get(targetKey),
  ]);
  if (srcSpl && tgtSpl) {
    // By RUN, as the timeline above, and re-ordered by when each run actually
    // started so a run taken from the source lands where it happened rather than
    // after everything this box recorded.
    tgtSpl.items = mergeItemRuns(tgtSpl.items, srcSpl.items);
    tgtSpl.items.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    tgtSpl.items.forEach((it, i) => { it.sequence = i; });
    if (srcSpl.endedAt && (!tgtSpl.endedAt || Date.parse(srcSpl.endedAt) > Date.parse(tgtSpl.endedAt))) {
      tgtSpl.endedAt = srcSpl.endedAt;
    }
    await splHistoryStore.upsert(tgtSpl);
    await splHistoryStore.delete(sourceKey);
    broadcast("spl:history", tgtSpl);
    outcome.merged.push("spl");
  } else if (srcSpl) {
    const moved = adoptIdentity(srcSpl, targetIdentity);
    await splHistoryStore.upsert(moved);
    await splHistoryStore.delete(sourceKey);
    broadcast("spl:history", moved);
    outcome.moved.push("spl");
  }

  console.log(
    `[history-edit] merge ${scrub(sourceKey)} -> ${scrub(targetKey)}: ` +
      `merged [${scrub(outcome.merged.join(", ") || "none")}], ` +
      `re-keyed [${scrub(outcome.moved.join(", ") || "none")}], ` +
      `archive ${scrub(outcome.archivesMoved ? "moved" : "left in place")}.`,
  );
  return outcome;
}
