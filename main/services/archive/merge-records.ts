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

/** Items this box never recorded are taken; items it has are left untouched. */
export function mergeSplRecord(mine: SplRecord, theirs: SplRecord): SplRecord {
  const merged = mergeByKey(mine.items ?? [], theirs.items ?? [], (i) => i.itemId);
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
 */
export function mergeAttendanceRecord(mine: AttendanceRecord, theirs: AttendanceRecord): AttendanceRecord {
  const samples = mergeByKey(mine.samples ?? [], theirs.samples ?? [], (s) => s.t).sort((a, b) =>
    a.t.localeCompare(b.t),
  );
  const out = { ...fillMissingFields(mine, theirs, ["samples"]), samples };
  const peakOf = (field: string) =>
    samples.reduce((m, s) => {
      const v = (s as unknown as Record<string, unknown>)[field];
      return typeof v === "number" ? Math.max(m, v) : m;
    }, 0);
  if (samples.length) {
    out.peakAttendance = Math.max(mine.peakAttendance ?? 0, peakOf("attendance"));
    out.peakOccupancy = Math.max(mine.peakOccupancy ?? 0, peakOf("occupancy"));
  }
  return out;
}

interface TimelineItem {
  itemId: string;
  sequence?: number;
}
interface TimelineRecord {
  items?: TimelineItem[];
  [k: string]: unknown;
}

export function mergeTimelineRecord(mine: TimelineRecord, theirs: TimelineRecord): TimelineRecord {
  const merged = mergeByKey(mine.items ?? [], theirs.items ?? [], (i) => i.itemId);
  return {
    ...fillMissingFields(mine, theirs, ["items"]),
    items: merged.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)),
  };
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
