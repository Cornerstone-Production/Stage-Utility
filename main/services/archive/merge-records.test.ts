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

test("attendance merge unions samples by timestamp and re-sorts", () => {
  const mine = { samples: [{ t: "2026-07-26T09:00:00.000Z", attendance: 10, occupancy: 10 }] };
  const theirs = {
    samples: [
      { t: "2026-07-26T08:30:00.000Z", attendance: 2, occupancy: 2 },
      { t: "2026-07-26T09:00:00.000Z", attendance: 999, occupancy: 999 },
      { t: "2026-07-26T09:30:00.000Z", attendance: 40, occupancy: 35 },
    ],
  };
  const out = mergeAttendanceRecord(mine, theirs);
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
  const out = mergeAttendanceRecord(mine, theirs);
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
  const out = mergeTimelineRecord(mine, theirs);
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
      { t: "t1", attendance: 1915, occupancy: 1800, phase: "post" },
      { t: "t3", attendance: 1400, occupancy: 1300, phase: "pre" },
    ],
  };
  const out = mergeAttendanceRecord(mine, theirs);
  assert.equal(out.samples!.length, 3, "the tagged samples are still kept");
  assert.equal(out.peakAttendance, 1810, "the taper sample did not raise the peak");
  assert.equal(out.peakOccupancy, 1700);
});

test("an in-service sample from the other machine does raise the peak", () => {
  const mine = { samples: [{ t: "t2", attendance: 100, occupancy: 90 }], peakAttendance: 100, peakOccupancy: 90 };
  const theirs = { samples: [{ t: "t1", attendance: 500, occupancy: 480 }] }; // untagged = in service
  const out = mergeAttendanceRecord(mine, theirs);
  assert.equal(out.peakAttendance, 500);
  assert.equal(out.peakOccupancy, 480);
});
