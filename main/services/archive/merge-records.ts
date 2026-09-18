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

interface AttendanceSample {
  t: string;
}
interface AttendanceRecord {
  samples?: AttendanceSample[];
  peakAttendance?: number;
  peakOccupancy?: number;
  [k: string]: unknown;
}

/**
 * Samples union by timestamp, then re-sorted oldest→newest.
 *
 * The peaks are recomputed rather than filled, because a peak taken over a gap is
 * wrong the moment the gap is filled — that is the whole point of merging.
 *
 * Only IN-SERVICE samples feed a peak. The recorder tags ramp and taper samples
 * with a `phase` and leaves the service proper untagged, precisely so an emptying
 * or filling room does not set the peak (see attendance-recorder.ts). Recomputing
 * over every sample quietly overrode that and inflated the figure — a service whose
 * stored peak was 1810 came back as 1915 off a taper sample.
 */
export function mergeAttendanceRecord(mine: AttendanceRecord, theirs: AttendanceRecord): AttendanceRecord {
  const samples = mergeByKey(mine.samples ?? [], theirs.samples ?? [], (s) => s.t).sort((a, b) =>
    a.t.localeCompare(b.t),
  );
  const out = { ...fillMissingFields(mine, theirs, ["samples"]), samples };
  const inService = samples.filter((s) => (s as unknown as Record<string, unknown>).phase == null);
  const peakOf = (field: string) =>
    inService.reduce((m, s) => {
      const v = (s as unknown as Record<string, unknown>)[field];
      return typeof v === "number" ? Math.max(m, v) : m;
    }, 0);
  if (inService.length) {
    out.peakAttendance = Math.max(mine.peakAttendance ?? 0, peakOf("attendance"));
    out.peakOccupancy = Math.max(mine.peakOccupancy ?? 0, peakOf("occupancy"));
  }
  return out;
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
