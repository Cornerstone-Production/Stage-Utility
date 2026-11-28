import { strict as assert } from "node:assert";
import { test } from "node:test";

import { encodeRow, parseRows } from "../csv.js";
import {
  fillMissingFields,
  mergeAttendanceRecord,
  mergeByKey,
  mergeCsv,
  mergeSplRecord,
  mergeTimelineRecord,
} from "./merge-records.js";

test("mergeByKey takes only what is missing, keeping the local entry on a clash", () => {
  const mine = [{ id: "a", who: "mine" }];
  const theirs = [
    { id: "a", who: "theirs" },
    { id: "b", who: "theirs" },
  ];
  assert.deepEqual(
    mergeByKey(mine, theirs, (v) => v.id),
    [
      { id: "a", who: "mine" },
      { id: "b", who: "theirs" },
    ],
  );
});

test("fillMissingFields never replaces a value this box actually has", () => {
  const out = fillMissingFields({ a: 1, b: null, c: undefined }, { a: 99, b: 2, c: 3 } as never);
  assert.deepEqual(out, { a: 1, b: 2, c: 3 });
});

test("fillMissingFields treats 0 and empty string as values, not gaps", () => {
  const out = fillMissingFields({ a: 0, b: "" }, { a: 5, b: "x" } as never);
  assert.deepEqual(out, { a: 0, b: "" });
});

test("SPL merge adds items this box never recorded and leaves its own alone", () => {
  const mine = { items: [{ itemId: "i1", sequence: 0, maxSpl: 90 }], meterId: null };
  const theirs = {
    items: [
      { itemId: "i1", sequence: 0, maxSpl: 120 },
      { itemId: "i2", sequence: 1, maxSpl: 88 },
    ],
    meterId: "m1",
  };
  const out = mergeSplRecord(mine, theirs);
  assert.equal(out.items!.length, 2);
  assert.equal((out.items![0] as unknown as { maxSpl: number }).maxSpl, 90, "local item untouched");
  assert.equal((out.items![1] as { itemId: string }).itemId, "i2", "missing item taken");
  assert.equal(out.meterId, "m1", "null local field filled");
});

// A plan item that ran twice is two entries, and a merge keyed on the item id
// alone contributed at most one of them — the second run's levels, or its
// timings, were dropped on the floor by every merge path in the app.
test("SPL merge keeps BOTH runs of an item the source recorded twice", () => {
  const mine = { items: [{ itemId: "doors", sequence: 0, maxSpl: 104 }], meterId: null };
  const theirs = {
    items: [
      { itemId: "doors", sequence: 0, maxSpl: 120 },
      { itemId: "song", sequence: 1, maxSpl: 99 },
      // The reprise this box never recorded.
      { itemId: "doors", sequence: 2, maxSpl: 78 },
    ],
    meterId: "m1",
  };
  const out = mergeSplRecord(mine, theirs);
  const doors = out.items!.filter((i) => i.itemId === "doors") as unknown as { maxSpl: number }[];
  assert.equal(doors.length, 2, "the source's second run of Doors was dropped");
  assert.equal(doors[0]!.maxSpl, 104, "the local run must not be overwritten");
  assert.equal(doors[1]!.maxSpl, 78, "the run taken is the source's SECOND one");
  assert.equal(out.items!.length, 3);
});

test("timeline merge keeps BOTH runs too", () => {
  const mine = { items: [{ itemId: "doors", sequence: 0, actualDurationSec: 497 }] };
  const theirs = {
    items: [
      { itemId: "doors", sequence: 0, actualDurationSec: 1 },
      { itemId: "doors", sequence: 1, actualDurationSec: 600 },
    ],
  };
  const out = mergeTimelineRecord(mine, theirs).record;
  assert.equal(out.items!.length, 2, "the source's second run was dropped");
  assert.equal((out.items![0] as unknown as { actualDurationSec: number }).actualDurationSec, 497);
  assert.equal((out.items![1] as unknown as { actualDurationSec: number }).actualDurationSec, 600);
});

// Why the key is the RUN INDEX and not `sequence`. Each recording numbers its
// own items, so two boxes watching one service disagree the moment either missed
// anything. Keyed on itemId + sequence, the SAME run recorded by both sides
// fails to match and is taken a second time: the merged record shows one item
// twice with two different levels, and merging stops being idempotent.
test("a merge does not duplicate a run both boxes recorded but numbered differently", () => {
  const mine = { items: [{ itemId: "doors", sequence: 0 }, { itemId: "song", sequence: 1 }] };
  // The same two runs off a box that also caught the pre-service, so everything
  // it recorded is numbered four higher.
  const theirs = { items: [{ itemId: "doors", sequence: 4 }, { itemId: "song", sequence: 5 }] };
  const out = mergeTimelineRecord(mine, theirs).record;
  assert.equal(out.items!.length, 2, "a run both boxes recorded was added a second time");
  assert.deepEqual(
    out.items!.map((i) => i.sequence),
    [0, 1],
    "the local entries must be the ones kept",
  );
});

// ── Item time corrections through an archive-import merge ──
//
// These used to ride through fillMissingFields, which is wrong twice over: it
// copies the incoming array only when this box has none, and it copies the keys
// verbatim onto a run list that has just been unioned.

test("an import merge keeps BOTH sides' item time corrections", () => {
  const mine = {
    items: [{ itemId: "doors", sequence: 0 }],
    itemTimeEdits: [{ itemId: "doors", sequence: 0, endedAt: "2026-09-17T20:20:00.000Z", editedAt: "x" }],
  };
  const theirs = {
    items: [{ itemId: "doors", sequence: 0 }, { itemId: "song", sequence: 1 }],
    itemTimeEdits: [{ itemId: "song", sequence: 1, endedAt: "2026-09-17T21:00:00.000Z", editedAt: "y" }],
  };
  const { record, droppedItemTimeEdits } = mergeTimelineRecord(mine, theirs);
  assert.deepEqual(
    record.itemTimeEdits?.map((e) => `${e.itemId}#${String(e.sequence)}`).sort(),
    ["doors#0", "song#1"],
    "the incoming correction was dropped because this box already had one",
  );
  assert.deepEqual(droppedItemTimeEdits, []);
});

test("an incoming correction lands on the run it described, not on this box's same number", () => {
  // Their box caught the pre-service, so everything it recorded is numbered four
  // higher — the same disagreement mergeItemRuns exists for. Their correction is
  // keyed `song#5`; this box's `song` is sequence 1. Copied by value, the
  // correction named a run that is not the one it was made about.
  const mine = { items: [{ itemId: "doors", sequence: 0 }, { itemId: "song", sequence: 1 }] };
  const theirs = {
    items: [{ itemId: "doors", sequence: 4 }, { itemId: "song", sequence: 5 }],
    itemTimeEdits: [{ itemId: "song", sequence: 5, endedAt: "2026-09-17T21:00:00.000Z", editedAt: "y" }],
  };
  const { record, droppedItemTimeEdits } = mergeTimelineRecord(mine, theirs);
  assert.equal(record.items!.length, 2, "precondition: the runs were unioned, not duplicated");
  assert.equal(record.itemTimeEdits, undefined, "their run lost the clash, so its correction goes with it");
  assert.deepEqual(
    droppedItemTimeEdits.map((e) => `${e.itemId}#${String(e.sequence)}`),
    ["song#5"],
    "and it must be REPORTED, not discarded in silence",
  );
});

test("an incoming correction for a run only they have is carried", () => {
  const mine = { items: [{ itemId: "doors", sequence: 0 }] };
  const theirs = {
    items: [{ itemId: "doors", sequence: 0 }, { itemId: "song", sequence: 1 }],
    itemTimeEdits: [{ itemId: "song", sequence: 1, endedAt: "2026-09-17T21:00:00.000Z", editedAt: "y" }],
  };
  const { record, droppedItemTimeEdits } = mergeTimelineRecord(mine, theirs);
  assert.deepEqual(record.itemTimeEdits?.map((e) => `${e.itemId}#${String(e.sequence)}`), ["song#1"]);
  assert.deepEqual(droppedItemTimeEdits, []);
});

test("attendance merge unions samples by timestamp and re-sorts", () => {
  const mine = { samples: [{ t: "2026-07-26T09:00:00.000Z", attendance: 10, occupancy: 10 }] };
  const theirs = {
    samples: [
      { t: "2026-07-26T08:30:00.000Z", attendance: 2, occupancy: 2 },
      { t: "2026-07-26T09:00:00.000Z", attendance: 999, occupancy: 999 },
      { t: "2026-07-26T09:30:00.000Z", attendance: 40, occupancy: 35 },
    ],
  };
  const out = mergeAttendanceRecord(mine, theirs).record;
  assert.deepEqual(
    out.samples!.map((s) => s.t),
    ["2026-07-26T08:30:00.000Z", "2026-07-26T09:00:00.000Z", "2026-07-26T09:30:00.000Z"],
  );
  const clash = out.samples!.find((s) => s.t === "2026-07-26T09:00:00.000Z") as unknown as { attendance: number };
  assert.equal(clash.attendance, 10, "local sample kept on a timestamp clash");
});

test("attendance merge recomputes the peak over the filled gap", () => {
  // A peak taken over a gap is wrong the moment the gap is filled.
  const mine = { samples: [{ t: "t2", attendance: 10, occupancy: 10 }], peakAttendance: 10, peakOccupancy: 10 };
  const theirs = { samples: [{ t: "t1", attendance: 500, occupancy: 480 }] };
  const out = mergeAttendanceRecord(mine, theirs).record;
  assert.equal(out.peakAttendance, 500);
  assert.equal(out.peakOccupancy, 480);
});

test("timeline merge adds missing items in sequence order", () => {
  const mine = { items: [{ itemId: "b", sequence: 1 }] };
  const theirs = {
    items: [
      { itemId: "a", sequence: 0 },
      { itemId: "b", sequence: 1 },
    ],
  };
  const out = mergeTimelineRecord(mine, theirs).record;
  assert.deepEqual(
    out.items!.map((i) => i.itemId),
    ["a", "b"],
  );
});

test("CSV merge unions rows by timestamp and keeps them ordered", () => {
  const mine = encodeRow(["at", "db"]) + encodeRow(["09:00", 90]) + encodeRow(["09:02", 92]);
  const theirs = encodeRow(["at", "db"]) + encodeRow(["09:01", 91]) + encodeRow(["09:02", 999]);
  const out = mergeCsv(mine, theirs, parseRows, encodeRow);
  assert.deepEqual(parseRows(out as string), [
    ["at", "db"],
    ["09:00", "90"],
    ["09:01", "91"],
    ["09:02", "92"],
  ]);
});

test("CSV merge refuses to interleave files with different column sets", () => {
  const mine = encodeRow(["at", "db"]) + encodeRow(["09:00", 90]);
  const theirs = encodeRow(["at", "db", "lceq"]) + encodeRow(["09:01", 91, 95]);
  assert.equal(mergeCsv(mine, theirs, parseRows, encodeRow), null);
});

test("CSV merge of an empty side returns the other unchanged", () => {
  const mine = encodeRow(["at", "db"]) + encodeRow(["09:00", 90]);
  assert.equal(mergeCsv("", mine, parseRows, encodeRow), mine);
  assert.equal(mergeCsv(mine, "", parseRows, encodeRow), mine);
});

test("merging is idempotent — running it twice changes nothing", () => {
  const mine = { items: [{ itemId: "i1", sequence: 0 }] };
  const theirs = { items: [{ itemId: "i2", sequence: 1 }] };
  const once = mergeSplRecord(mine, theirs);
  const twice = mergeSplRecord(once, theirs);
  assert.deepEqual(twice, once);
});

test("a ramp or taper sample never sets the peak", () => {
  // The recorder tags ramp/taper and leaves the service proper untagged, so that an
  // emptying or filling room cannot set the peak. Merging must respect that: a real
  // record came back as 1915 instead of its stored 1810 off a taper sample.
  const mine = {
    samples: [{ t: "t2", attendance: 1810, occupancy: 1700 }],
    peakAttendance: 1810,
    peakOccupancy: 1700,
  };
  const theirs = {
    samples: [
      { t: "t1", attendance: 1915, occupancy: 1800, phase: "post" as const },
      { t: "t3", attendance: 1400, occupancy: 1300, phase: "pre" as const },
    ],
  };
  const out = mergeAttendanceRecord(mine, theirs).record;
  assert.equal(out.samples!.length, 3, "the tagged samples are still kept");
  assert.equal(out.peakAttendance, 1810, "the taper sample did not raise the peak");
  assert.equal(out.peakOccupancy, 1700);
});

test("an in-service sample from the other machine does raise the peak", () => {
  const mine = { samples: [{ t: "t2", attendance: 100, occupancy: 90 }], peakAttendance: 100, peakOccupancy: 90 };
  const theirs = { samples: [{ t: "t1", attendance: 500, occupancy: 480 }] }; // untagged = in service
  const out = mergeAttendanceRecord(mine, theirs).record;
  assert.equal(out.peakAttendance, 500);
  assert.equal(out.peakOccupancy, 480);
});

// ── Two boxes, two baselines ────────────────────────────────────────────────
//
// Each box stores attendance as the raw daily counter minus ITS OWN baseline:
// the counter's value when that box's record began. Box A opened the 9am at a
// raw count of 500; box B, restarted ten minutes in, opened its record at 520.
// The two boxes stamp samples from separate clocks, so their timestamps almost
// never match and a union keeps nearly all of both series. Unshifted, every B
// sample read twenty people lower than its A neighbour and the merged curve
// saw-toothed across the whole overlap, while lastAttendance and minOccupancy
// kept A's pre-merge values.

const T9 = Date.parse("2026-07-26T09:00:00.000Z");
/** The raw daily counter at minute `m`: two people a minute. */
const rawAt = (m: number) => 500 + 2 * m;

/** A box's record of minutes `from`..`to`, baselined at its own first reading,
 *  stamped `skewSec` seconds off the minute. */
function boxRecord(from: number, to: number, skewSec: number, occupancy: (m: number) => number) {
  const baseline = rawAt(from);
  const minutes = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const samples = minutes.map((m) => ({
    t: new Date(T9 + m * 60_000 + skewSec * 1000).toISOString(),
    attendance: rawAt(m) - baseline,
    occupancy: occupancy(m),
  }));
  return {
    serviceKey: "st1:plan:9am",
    attendanceBaseline: baseline,
    totalAttendance: rawAt(to),
    samples,
    peakAttendance: rawAt(to) - baseline,
    peakOccupancy: Math.max(...minutes.map(occupancy)),
    minOccupancy: Math.min(...minutes.map(occupancy)),
    lastAttendance: rawAt(to) - baseline,
    lastOccupancy: occupancy(to),
  };
}

test("two boxes with different baselines import to one continuous curve", () => {
  const a = boxRecord(0, 25, 0, () => 300); // this box: 9:00-9:25, baseline 500
  const b = boxRecord(10, 30, 7, (m) => (m === 28 ? 250 : 310)); // the archive's box: 9:10-9:30, baseline 520

  const out = mergeAttendanceRecord(a, b).record as ReturnType<typeof boxRecord>;

  // Every sample in ONE frame: the earlier baseline, raw 500.
  assert.equal(out.attendanceBaseline, 500);
  const series = out.samples.map((s) => s.attendance);
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i]! >= series[i - 1]!, `saw-tooth at sample ${i}: ${series.slice(Math.max(0, i - 2), i + 2).join(", ")}`);
  }
  assert.equal(series.at(-1), rawAt(30) - 500, "the archive's tail reads in this box's frame");
  assert.equal(out.lastAttendance, rawAt(30) - 500, "last comes from the later of the two recordings");
  assert.equal(out.lastOccupancy, 310);
  assert.equal(out.peakAttendance, rawAt(30) - 500);
  assert.equal(out.minOccupancy, 250, "the archive's lower floor is not lost");
});

test("an archive whose box started first moves this box's samples into its frame", () => {
  const a = boxRecord(10, 30, 0, () => 300); // this box restarted: baseline 520
  const b = boxRecord(0, 20, 7, () => 300); // the archive's box was there from the start: 500

  const out = mergeAttendanceRecord(a, b).record as ReturnType<typeof boxRecord>;

  assert.equal(out.attendanceBaseline, 500, "the earlier baseline");
  const series = out.samples.map((s) => s.attendance);
  for (let i = 1; i < series.length; i++) assert.ok(series[i]! >= series[i - 1]!, `saw-tooth at ${i}`);
  assert.equal(series.at(-1), rawAt(30) - 500);
  assert.equal(out.peakAttendance, rawAt(30) - 500, "this box's stored peak moved into the merged frame");
  assert.deepEqual(a.samples[0], { t: new Date(T9 + 10 * 60_000).toISOString(), attendance: 0, occupancy: 300 }, "the local record's own samples are not mutated");
});

test("a figure a recording stored is a floor the samples cannot lower", () => {
  // The recorder takes its peak and floor off every reading but keeps a sample
  // only every 30 seconds, so the stored figures can lie outside the samples.
  const a = { ...boxRecord(0, 10, 0, () => 300), peakAttendance: 99, peakOccupancy: 410, minOccupancy: 120 };
  const b = boxRecord(5, 15, 7, () => 300);

  const out = mergeAttendanceRecord(a, b).record;

  assert.equal(out.peakAttendance, Math.max(99, rawAt(15) - 500));
  assert.equal(out.peakOccupancy, 410);
  assert.equal(out.minOccupancy, 120);
});

test("importing a recording that adds nothing leaves the record as it was", () => {
  const a = { ...boxRecord(0, 20, 0, (m) => 300 + m), peakAttendance: 41, minOccupancy: 290, lastAttendance: 41 };
  const b = { ...a, samples: a.samples.slice(3, 9) };
  assert.deepEqual(mergeAttendanceRecord(a, b).record, a);
});

test("an attendance merge is idempotent across two baselines", () => {
  const a = boxRecord(0, 25, 0, () => 300);
  const b = boxRecord(10, 30, 7, (m) => (m === 28 ? 250 : 310));
  const once = mergeAttendanceRecord(a, b).record;
  assert.deepEqual(mergeAttendanceRecord(once, b).record, once);
});

test("a baseline that is not a number shifts nothing, and the merge says it could not align", () => {
  const a = boxRecord(0, 10, 0, () => 300);
  const b = { ...boxRecord(5, 15, 7, () => 300), attendanceBaseline: "520" as unknown as number };

  const { record, frames } = mergeAttendanceRecord(a, b);

  assert.equal(frames, "unknown");
  assert.equal(record.attendanceBaseline, 500);
  assert.ok(record.samples!.every((s) => Number.isFinite((s as { attendance: number }).attendance)), "no NaN reached a sample");
  assert.equal(mergeAttendanceRecord(a, boxRecord(5, 15, 7, () => 300)).frames, "aligned");
});

test("a stored peak above the samples moves into the merged frame with them", () => {
  // This box restarted (baseline 520) and its recorder saw a peak of 50 that no
  // kept sample holds; the archive's box was there from 500.
  const a = { ...boxRecord(10, 20, 0, () => 300), peakAttendance: 50 };
  const b = boxRecord(0, 15, 7, () => 300);

  const out = mergeAttendanceRecord(a, b).record;

  assert.equal(out.attendanceBaseline, 500);
  assert.equal(out.peakAttendance, 50 + 20, "the stored peak was not shifted with this box's samples");
});

test("a ramp-only recording's stored 0 is not a floor once shifted", () => {
  const a = { ...boxRecord(0, 2, 0, () => 300), peakAttendance: 4 }; // in service, peak 4, baseline 500
  const ramp = boxRecord(20, 25, 7, () => 300); // baseline 540, every sample before the service
  const b = { ...ramp, samples: ramp.samples.map((s) => ({ ...s, phase: "pre" as const })), peakAttendance: 0, minOccupancy: null };

  const out = mergeAttendanceRecord(a, b).record;

  assert.equal(out.peakAttendance, 4, "the ramp's stored 0, shifted by 40, became a peak of 40");
});

test("an incoming sample that is not a reading is left out and counted, and no figure is poisoned", () => {
  const a = boxRecord(0, 10, 0, () => 300);
  const b = boxRecord(5, 15, 7, () => 300);
  const bad = [
    { t: "2026-07-26T09:05:30.000Z", attendance: "12", occupancy: 300 },
    { t: "2026-07-26T09:05:40.000Z", occupancy: 300 },
    null,
  ];
  const { record, skippedSamples } = mergeAttendanceRecord(a, { ...b, samples: [...b.samples, ...bad] as never });

  assert.equal(skippedSamples, 3);
  assert.equal(record.samples!.length, a.samples.length + b.samples.length);
  for (const f of ["peakAttendance", "peakOccupancy", "minOccupancy", "lastAttendance", "lastOccupancy"] as const) {
    assert.ok(Number.isFinite(record[f]), `${f} is ${String(record[f])}`);
  }
  assert.equal(record.peakAttendance, rawAt(15) - 500);
  assert.equal(mergeAttendanceRecord(a, { ...b, samples: "not a list" as never }).record.peakAttendance, a.peakAttendance, "a samples field that is not a list adds nothing");
});

test("a merge that could not align keeps this box's baseline rather than adopting the other's", () => {
  const a = { ...boxRecord(0, 10, 0, () => 300), attendanceBaseline: null };
  const b = boxRecord(5, 15, 7, () => 300);
  const { record, frames } = mergeAttendanceRecord(a, b);
  assert.equal(frames, "unknown");
  assert.equal(record.attendanceBaseline, null, "a known baseline stamped on a mixed series makes the next merge shift it");
});

test("the raw daily total takes the later, larger figure", () => {
  const a = boxRecord(0, 25, 0, () => 300);
  const b = boxRecord(10, 30, 7, () => 300);
  assert.equal(mergeAttendanceRecord(a, b).record.totalAttendance, rawAt(30));
});

test("this box's own sample that is not a number is carried as it is, never shifted or counted", () => {
  // A record taken whole by an earlier import is this box's own from then on.
  const a = boxRecord(10, 15, 0, () => 300); // baseline 520
  a.samples[1] = { ...a.samples[1]!, attendance: "12" as unknown as number };
  const b = boxRecord(0, 12, 7, () => 300); // baseline 500

  const out = mergeAttendanceRecord(a, b).record;

  const carried = out.samples!.find((s) => s.t === a.samples[1]!.t) as unknown as { attendance: unknown };
  assert.equal(carried.attendance, "12", "a string attendance was shifted into a longer string");
  assert.equal(out.samples!.length, a.samples.length + b.samples.length, "this box's own sample was dropped");
  assert.equal(out.peakAttendance, rawAt(15) - 500);
  assert.ok(Number.isFinite(out.lastAttendance) && Number.isFinite(out.minOccupancy), "a figure was poisoned");
});

test("an incoming recording placed onto an empty record of this box keeps its own baseline, not this box's", () => {
  const a = { ...boxRecord(0, 0, 0, () => 300), samples: [] };
  const b = { ...boxRecord(5, 10, 7, () => 300), attendanceBaseline: null };
  assert.equal(mergeAttendanceRecord(a, b).record.attendanceBaseline, null);
});

// ── Baselines that cannot both be right ─────────────────────────────────────
//
// Recalculate, Edit times and History's merge in v1.9.3 and v1.9.4 (fixed in
// v1.10.0) wrote an already-baselined value into attendanceBaseline, normally
// 0, and left the samples alone. Aligning on such a record shifts the other
// recording by every entry before its service. Where the two overlap, both
// boxes read one counter, so baseline + sample must agree between them.

test("an import over a record whose baseline disagrees with the other box's is not shifted, and says why", () => {
  // This box's 9am: really baselined at raw 500, but a v1.9.3 Recalculate left 0.
  const corrupted = { ...boxRecord(0, 10, 0, () => 300), attendanceBaseline: 0 };
  const b = boxRecord(5, 15, 7, () => 300); // the archive's box, honestly baselined at 510

  const { record, frames, implausible } = mergeAttendanceRecord(corrupted, b);

  const series = record.samples!.map((s) => (s as { attendance: number }).attendance);
  assert.ok(Math.max(...series) < 100, `the archive's samples were shifted by the whole morning: ${series.join(", ")}`);
  assert.equal(frames, "implausible");
  assert.match(implausible ?? "", /disagree by about 500/);
  assert.equal(record.attendanceBaseline, 0, "this box's baseline is kept as it was");
  assert.equal(mergeAttendanceRecord(boxRecord(0, 10, 0, () => 300), { ...b, attendanceBaseline: 0 }).frames, "implausible", "the archive's side, the same");
});

test("a trimmed or split-saved record that agrees with the other box still aligns", () => {
  // Its daily total ran on hundreds past its last kept sample: a window trim,
  // or a split save in the next service's arrivals. Its baseline is right.
  const trimmed = { ...boxRecord(0, 25, 0, () => 300), totalAttendance: rawAt(25) + 600 };
  const b = boxRecord(10, 30, 7, () => 300);
  assert.equal(mergeAttendanceRecord(trimmed, b).frames, "aligned");
});

test("with no overlap, only the bug's own signature is not aligned on", () => {
  // Baseline equal to its first sample (the value the bug copied in) and a
  // total far above baseline + latest: the shape v1.9.3 left.
  const corrupted = { ...boxRecord(0, 10, 0, () => 300), attendanceBaseline: 0 };
  const later = boxRecord(20, 30, 7, () => 300);
  const { frames, implausible } = mergeAttendanceRecord(corrupted, later);
  assert.equal(frames, "implausible");
  assert.match(implausible ?? "", /this box's record's baseline 0 equals its first sample/);
  // A trimmed record with a real baseline is not that shape.
  const trimmed = { ...boxRecord(0, 10, 0, () => 300), totalAttendance: rawAt(10) + 600 };
  assert.equal(mergeAttendanceRecord(trimmed, later).frames, "aligned");
});

test("an empty record's baseline is no frame: a Recalculate on it then an import shifts nothing", async () => {
  const { recomputeAttendance } = await import("../attendance-aggregate.js");
  const empty = { ...boxRecord(0, 0, 0, () => 300), samples: [], attendanceBaseline: null, totalAttendance: 0 };
  recomputeAttendance(empty as never);
  assert.equal(empty.attendanceBaseline, null, "a recompute of a record with no samples stamped a baseline");
  const withZero = { ...empty, attendanceBaseline: 0 }; // what the old recompute left
  const b = boxRecord(10, 20, 7, () => 300); // baseline 520

  const out = mergeAttendanceRecord(withZero, b).record;

  assert.deepEqual(out.samples!.map((s) => (s as { attendance: number }).attendance), b.samples.map((s) => s.attendance), "shifted onto an empty record's 0");
  assert.equal(out.attendanceBaseline, 520);
});

test("a reading whose stamp will not parse does not decide the check", () => {
  const a = boxRecord(0, 10, 0, () => 300);
  const b = boxRecord(5, 15, 7, () => 300);
  const bogus = { ...b, samples: [{ t: "bogus", attendance: 0, occupancy: 300 }, ...b.samples] };
  assert.equal(mergeAttendanceRecord(a, bogus).frames, "aligned");
});
