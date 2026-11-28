// merge-records.ts — combine two recordings of the same service.
//
// The case this exists for: one service, two machines, neither with the whole
// thing. A box that restarted at 09:20 is missing twenty minutes another box has.
// Replacing would trade one gap for another; skipping keeps the gap.
//
// The rule throughout is FILL, NEVER OVERWRITE. Anything this box already has is
// kept exactly as it is; only what is missing is taken from the archive. That makes
// the result predictable and the operation safe to run twice.
//
// One thing is deliberately NOT merged: the per-item SPL aggregates when both sides
// have the same item. `max`/`leq`/`count` can be combined exactly — energy-weighted
// by count — but only if the two recordings cover DISJOINT seconds, and two boxes
// watching the same live service overlap almost entirely. Combining them would
// count the same sound twice and inflate the result. Where both sides recorded an
// item, this keeps the local figures and says so. (The raw CSVs are merged by
// timestamp, so the samples needed to recompute it properly are retained.)

import type { AttendanceSample } from "../../types/history.js";
import { alignAttendance, attendanceStats, finiteOrNull, inServiceSamples, type FrameShift } from "../attendance-aggregate.js";

/** Union two arrays of objects by a key field, keeping the local entry on a clash. */
export function mergeByKey<T>(mine: T[], theirs: T[], key: (v: T) => string | null | undefined): T[] {
  const seen = new Set(mine.map(key).filter((k): k is string => k != null));
  const extra = theirs.filter((t) => {
    const k = key(t);
    return k != null && !seen.has(k);
  });
  return [...mine, ...extra];
}

/**
 * Union per-item entries, keeping the local entry where both sides have the
 * same RUN of the same item.
 *
 * A plan item can appear more than once in one record — a reprise, or a second
 * service whose occurrence split was missed — and `itemId` alone is therefore not
 * an identity: keyed on it, a source recording with two runs of Doors
 * contributed at most one, and the second was silently dropped by every merge
 * path in the app.
 *
 * The key is the item id plus its RUN INDEX (the nth appearance of that id in
 * that record), and deliberately NOT `sequence`. Each recording numbers its own
 * items, and two boxes watching one service number them differently the moment
 * one of them missed anything: keyed on `itemId:sequence`, the SAME run recorded
 * by both sides fails to match and is taken again, so the merged record shows
 * one item twice with two different levels and merging stops being idempotent.
 * Run index matches those, and its own failure — two boxes that disagree about
 * how many times an item ran — can only ever lose a run of that one item, never
 * duplicate anything and never touch another item. Gaps are what a merge is for;
 * invented duplicates are not.
 */
export function mergeItemRuns<T extends { itemId: string }>(mine: T[], theirs: T[]): T[] {
  const runKeys = (items: T[]): string[] => {
    const seenPerId = new Map<string, number>();
    return items.map((i) => {
      const n = seenPerId.get(i.itemId) ?? 0;
      seenPerId.set(i.itemId, n + 1);
      return `${i.itemId}#${n}`;
    });
  };
  const mineKeys = new Set(runKeys(mine));
  const theirKeys = runKeys(theirs);
  return [...mine, ...theirs.filter((_, i) => !mineKeys.has(theirKeys[i]!))];
}

/** Fill fields that are null/undefined locally from the incoming record. Never
 *  replaces a value this box actually has. */
export function fillMissingFields<T extends Record<string, unknown>>(mine: T, theirs: T, skip: string[] = []): T {
  const out = { ...mine };
  for (const [k, v] of Object.entries(theirs)) {
    if (skip.includes(k)) continue;
    if (out[k] === null || out[k] === undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

interface SplItem {
  itemId: string;
  sequence?: number;
}
interface SplRecord {
  items?: SplItem[];
  [k: string]: unknown;
}

/** Runs this box never recorded are taken; runs it has are left untouched. */
export function mergeSplRecord(mine: SplRecord, theirs: SplRecord): SplRecord {
  const merged = mergeItemRuns(mine.items ?? [], theirs.items ?? []);
  return {
    ...fillMissingFields(mine, theirs, ["items"]),
    items: merged.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)),
  };
}

/** An attendance record as a bundle carries it: unvalidated, so every field
 *  this reads is checked rather than trusted. */
interface AttendanceRecord {
  samples?: AttendanceSample[];
  attendanceBaseline?: number | null;
  peakAttendance?: number;
  peakOccupancy?: number;
  minOccupancy?: number | null;
  lastAttendance?: number;
  lastOccupancy?: number;
  totalAttendance?: number;
  [k: string]: unknown;
}

/** What an attendance merge produced, and what it could not do. */
export interface MergedAttendanceRecord {
  record: AttendanceRecord;
  /** "unknown" when one side had no usable baseline, and "implausible" when
   *  the two baselines cannot both be right (see framesDisagree):
   *  either way the two series were joined as they stood, unshifted. Returned
   *  so the import can say so. */
  frames: "aligned" | "unknown" | "implausible";
  /** For "implausible": the numbers that gave it away. */
  implausible?: string;
  /** Incoming samples left out because they were not readings: no string
   *  stamp, or an attendance or occupancy that is not a number. */
  skippedSamples: number;
}

/** Readings with a stamp Date can read, oldest first, as [ms, raw counter]. */
function rawSeries(r: AttendanceRecord, base: number): [number, number][] {
  return (Array.isArray(r.samples) ? r.samples : [])
    .filter(isReading)
    .map((x): [number, number] => [Date.parse(x.t), base + x.attendance])
    .filter(([t]) => Number.isFinite(t))
    .sort((x, y) => x[0] - y[0]);
}

/** Two readings this close together read the counter at nearly one moment. */
const PAIR_MS = 15_000;

/**
 * Why two records' baselines cannot be aligned on, or null when they can (or
 * when there is nothing to judge by, and the baselines are trusted).
 *
 * Recalculate, Edit times and History's merge in v1.9.3 and v1.9.4 (fixed in
 * v1.10.0) wrote an already-baselined value (normally 0) into
 * attendanceBaseline and left the samples alone. Such a record claims to count
 * from 0 while its samples count from wherever its service began, and aligning
 * on it shifts the other recording by every entry before that service.
 *
 * Where the two recordings overlap — the restarted-box case this alignment is
 * for — the evidence is direct: both boxes read the same counter, so baseline
 * + sample must agree between readings taken within 15 seconds of each other.
 * A median disagreement over 20 people or 5% means one baseline is wrong, and
 * which one cannot be told. A window trim, a split save or a crash leaves both
 * agreeing, so none of those is flagged.
 *
 * Where they do not overlap there is no such evidence, and only the bug's own
 * signature is looked for: a baseline equal to the record's first sample (the
 * value the bug copied in, unchanged since) on a record whose daily total sits
 * well above baseline + its latest sample. A legitimate record shares that
 * shape only when its counter really started near zero, where a shift by its
 * baseline is right anyway, or a trimmed one did; the fallback then costs what
 * every import did before this alignment existed, plus a line on the log. A
 * corrupted record a later fixed-code edit re-based is not recognised.
 */
export function framesDisagree(mine: AttendanceRecord, theirs: AttendanceRecord): string | null {
  const mineBase = finiteOrNull(mine.attendanceBaseline);
  const theirBase = finiteOrNull(theirs.attendanceBaseline);
  if (mineBase == null || theirBase == null) return null;
  const a = rawSeries(mine, mineBase);
  const b = rawSeries(theirs, theirBase);
  if (!a.length || !b.length) return null;

  const diffs: number[] = [];
  const levels: number[] = [];
  for (const [t, raw] of b) {
    let best: [number, number] | null = null;
    for (const p of a) if (Math.abs(p[0] - t) <= PAIR_MS && (best == null || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
    if (best) {
      diffs.push(Math.abs(best[1] - raw));
      levels.push(Math.max(best[1], raw));
    }
  }
  if (diffs.length >= 3) {
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
    const off = median(diffs);
    if (off > Math.max(20, median(levels) * 0.05)) {
      return `where the two recordings overlap their counts disagree by about ${off} people (baselines ${mineBase} and ${theirBase})`;
    }
    return null;
  }

  const signature = (r: AttendanceRecord, base: number, series: [number, number][], who: string): string | null => {
    const total = finiteOrNull(r.totalAttendance);
    const readings = (Array.isArray(r.samples) ? r.samples : []).filter(isReading).filter((x) => Number.isFinite(Date.parse(x.t)));
    const first = readings.reduce<AttendanceSample | null>((m, x) => (m == null || Date.parse(x.t) < Date.parse(m.t) ? x : m), null);
    if (total == null || total <= 0 || first == null || base !== first.attendance) return null;
    const latest = series[series.length - 1][1];
    if (total - latest <= Math.max(10, Math.round(total * 0.02))) return null;
    return `${who}'s baseline ${base} equals its first sample, and baseline + its latest sample is ${latest} while its daily total reads ${total}`;
  };
  return signature(mine, mineBase, a, "this box's record") ?? signature(theirs, theirBase, b, "the archive's record");
}

/**
 * The merge as it was before frames were aligned, for a record whose baseline
 * cannot be trusted: samples unioned unshifted (this box's on a clash), the
 * peaks recomputed over in-service samples and never lowered, everything else
 * filled, never overwritten. This box's baseline is kept, never filled from
 * the archive's.
 */
function fillOnlyAttendance(mine: AttendanceRecord, theirs: AttendanceRecord, readings: AttendanceSample[]): AttendanceRecord {
  const own = Array.isArray(mine.samples) ? mine.samples : [];
  const samples = mergeByKey(own, readings, (x) => x.t).sort((a, b) => a.t.localeCompare(b.t));
  const out: AttendanceRecord = { ...fillMissingFields(mine, theirs, ["samples", "attendanceBaseline"]), samples };
  const svc = inServiceSamples(samples);
  if (svc.length) {
    const peakOf = (field: "attendance" | "occupancy") =>
      svc.reduce((m, x) => Math.max(m, finiteOrNull(x[field]) ?? 0), 0);
    out.peakAttendance = Math.max(finiteOrNull(mine.peakAttendance) ?? 0, peakOf("attendance"));
    out.peakOccupancy = Math.max(finiteOrNull(mine.peakOccupancy) ?? 0, peakOf("occupancy"));
  }
  return out;
}

/** A sample an import can take: a stamp and two numbers. */
function isReading(s: unknown): s is AttendanceSample {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return typeof r.t === "string" && finiteOrNull(r.attendance) != null && finiteOrNull(r.occupancy) != null;
}

/**
 * Samples from both recordings, in ONE frame, oldest first; the figures
 * re-derived over the filled gaps.
 *
 * The two boxes' series are first shifted into the earlier of their two
 * baselines (alignAttendance, shared with History's merge). Each box stores
 * attendance as the raw counter minus its OWN baseline, so unshifted, a box that
 * restarted mid-service and opened its record twenty people later read twenty
 * low across the whole overlap: the curve saw-toothed, and the last and lowest
 * figures kept this box's pre-merge values.
 *
 * The figures are recomputed, because a figure taken over a gap is wrong the
 * moment the gap is filled. Only IN-SERVICE samples feed them: the recorder tags
 * ramp and taper samples with a `phase` so an emptying or filling room does not
 * set the peak — a service whose stored peak was 1810 once came back as 1915 off
 * a taper sample.
 *
 * Unlike History's merge, a figure a recording STORED bounds the result here,
 * rather than being replaced by the samples: the recorder takes peak and lowest
 * off every reading but keeps a sample only every 30 seconds, so a recompute
 * over samples alone could lower a peak this box actually saw. The peaks never
 * fall below, and the lowest never rises above, what either recording stored.
 * Stored attendance is shifted into the merged frame first, and a recording's
 * stored figures count only when it has in-service samples (a ramp-only
 * record's stored 0 means "none", not "zero people"). Last is the later
 * recording's own. totalAttendance, the raw daily counter, takes the later
 * (larger) of the two. A union with no in-service samples at all keeps this
 * box's figures, as before.
 *
 * The incoming record is unvalidated bundle input, so a sample that is not a
 * reading is left out and counted; this box's own samples are kept as they are.
 * The samples are not re-based to their first reading, as History's
 * recomputeAttendance does: the merged frame is the earlier record's own, whose
 * first reading is already its zero, and the rule here is fill, never rewrite.
 */
export function mergeAttendanceRecord(mine: AttendanceRecord, theirs: AttendanceRecord): MergedAttendanceRecord {
  const incoming: unknown[] = Array.isArray(theirs.samples) ? theirs.samples : [];
  const readings = incoming.filter(isReading);
  const skippedSamples = incoming.length - readings.length;
  const disagree = framesDisagree(mine, { ...theirs, samples: readings });
  if (disagree) {
    return { record: fillOnlyAttendance(mine, theirs, readings), frames: "implausible", implausible: disagree, skippedSamples };
  }
  const aligned = alignAttendance(mine, { ...theirs, samples: readings });
  const out: AttendanceRecord = {
    ...fillMissingFields(mine, theirs, ["samples", "attendanceBaseline"]),
    samples: aligned.samples,
    attendanceBaseline: aligned.attendanceBaseline,
  };
  const totals = [mine.totalAttendance, theirs.totalAttendance].map(finiteOrNull).filter((v): v is number => v != null);
  if (totals.length) out.totalAttendance = Math.max(...totals);
  const done = { record: out, frames: aligned.frames, skippedSamples };

  if (inServiceSamples(aligned.samples).length === 0) return done;

  const side = (r: AttendanceRecord, samples: AttendanceSample[], shift: FrameShift) => {
    const svc = inServiceSamples(samples);
    return { r, shift, svc: svc.length > 0, lastT: svc.length ? Date.parse(svc[svc.length - 1].t) : Number.NaN };
  };
  const here = side(mine, Array.isArray(mine.samples) ? mine.samples : [], aligned.intoShift);
  const there = side(theirs, readings, aligned.fromShift);
  const stored = (field: "peakAttendance" | "peakOccupancy" | "minOccupancy", shifted: boolean) =>
    [here, there].flatMap(({ r, shift, svc }) => {
      const v = svc ? finiteOrNull(r[field]) : null;
      return v == null ? [] : [shifted ? shift(v) : v];
    });

  const stats = attendanceStats(aligned.samples);
  out.peakAttendance = Math.max(stats.peakAttendance, ...stored("peakAttendance", true));
  out.peakOccupancy = Math.max(stats.peakOccupancy, ...stored("peakOccupancy", false));
  const floors = [stats.minOccupancy, ...stored("minOccupancy", false)].filter((v): v is number => v != null);
  out.minOccupancy = floors.length ? Math.min(...floors) : null;

  // Last is the later recording's own last reading, which is up to 30 seconds
  // newer than its last sample; the samples answer only when it stored none.
  const later = there.svc && (!here.svc || there.lastT > here.lastT) ? there : here;
  const lastA = later.svc ? finiteOrNull(later.r.lastAttendance) : null;
  const lastO = later.svc ? finiteOrNull(later.r.lastOccupancy) : null;
  out.lastAttendance = lastA == null ? stats.lastAttendance : Math.max(0, later.shift(lastA));
  out.lastOccupancy = lastO ?? stats.lastOccupancy;
  return done;
}

interface TimelineItem {
  itemId: string;
  sequence?: number;
}
interface TimelineItemTimeEdit {
  itemId: string;
  sequence: number;
  [k: string]: unknown;
}
interface TimelineRecord {
  items?: TimelineItem[];
  itemTimeEdits?: TimelineItemTimeEdit[];
  [k: string]: unknown;
}

/** What a timeline merge produced, and what it could not keep. */
export interface MergedTimelineRecord {
  record: TimelineRecord;
  /** Corrections whose run did not survive the merge. Returned rather than
   *  dropped in silence — they are the operator's work, and the import reports
   *  them. */
  droppedItemTimeEdits: TimelineItemTimeEdit[];
}

/**
 * Union two timelines, and carry BOTH sides' item time corrections.
 *
 * `itemTimeEdits` used to ride through `fillMissingFields`, which is wrong twice
 * over. It copies the incoming array only when this box has none — so an import
 * into a record that had been corrected here dropped every incoming correction
 * without a word — and it copies them by VALUE, keys and all, so an incoming
 * correction naming `song#2` landed on whatever this box's `song#2` happened to
 * be, which after a run-level union is frequently a different run.
 *
 * Bound to the ITEM OBJECTS first and re-keyed from the merged list after, the
 * way mergeServiceRecords does it: `mergeItemRuns` returns the references it was
 * given, so identity is what survives. A correction whose run lost the clash —
 * "fill, never overwrite" means the local run wins — goes with it, and is
 * reported.
 */
export function mergeTimelineRecord(mine: TimelineRecord, theirs: TimelineRecord): MergedTimelineRecord {
  const bound = new Map<TimelineItem, TimelineItemTimeEdit>();
  const bind = (rec: TimelineRecord) => {
    for (const edit of rec.itemTimeEdits ?? []) {
      const item = (rec.items ?? []).find((x) => x.itemId === edit.itemId && x.sequence === edit.sequence);
      // Two corrections for one run cannot both apply; the last wins, as
      // applyItemTimeEdits does, rather than the first silently shadowing it.
      if (item) bound.set(item, edit);
    }
  };
  bind(mine);
  bind(theirs);

  const merged = mergeItemRuns(mine.items ?? [], theirs.items ?? []).sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
  );

  const kept: TimelineItemTimeEdit[] = [];
  const carried = new Set<TimelineItemTimeEdit>();
  for (const item of merged) {
    const edit = bound.get(item);
    if (!edit) continue;
    carried.add(edit);
    kept.push({ ...edit, itemId: item.itemId, sequence: item.sequence ?? edit.sequence });
  }
  const dropped = [...(mine.itemTimeEdits ?? []), ...(theirs.itemTimeEdits ?? [])].filter(
    (e) => !carried.has(e),
  );

  const record: TimelineRecord = {
    // itemTimeEdits is skipped here and set below: fillMissingFields would adopt
    // the incoming array wholesale whenever this box had none.
    ...fillMissingFields(mine, theirs, ["items", "itemTimeEdits"]),
    items: merged,
  };
  if (kept.length) record.itemTimeEdits = kept;
  else delete record.itemTimeEdits;
  return { record, droppedItemTimeEdits: dropped };
}

/**
 * Union two CSV texts on the first column (the timestamp), keeping the local row
 * where both have one. Returns null when the headers disagree, since rows written
 * against different column sets cannot be interleaved — the caller keeps both files
 * rather than producing a ragged one.
 */
export function mergeCsv(mine: string, theirs: string, parse: (t: string) => string[][], encode: (r: (string | number | null)[]) => string): string | null {
  const a = parse(mine);
  const b = parse(theirs);
  if (a.length === 0) return theirs;
  if (b.length === 0) return mine;
  const header = a[0];
  if (header.length !== b[0].length || !header.every((h, i) => h === b[0][i])) return null;

  const seen = new Set(a.slice(1).map((r) => r[0]));
  const extra = b.slice(1).filter((r) => !seen.has(r[0]));
  const rows = [...a.slice(1), ...extra].sort((x, y) => x[0].localeCompare(y[0]));
  return [header, ...rows].map((r) => encode(r)).join("");
}
