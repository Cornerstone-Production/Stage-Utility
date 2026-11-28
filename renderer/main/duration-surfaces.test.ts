import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fmtLen, fmtTotal } from "./servicecue-columns.js";
import { fmtDuration } from "./pco-timer.js";
import { fmtClock } from "./use-baptism-state.js";
import { fmtDelta, fmtDur } from "../settings/sections/overview-data.js";
import { elapsedSince, formatDuration } from "../app/recording-status.js";
import { formatRecordTimecode } from "../../main/services/obs-record-clock.js";

// One datum, one string. A plan item of 4500 s printed "75:00" in the ServiceCue
// Length column and "1:15:00" in the layout rundown and on Home; the shared
// formatter is the only thing that can keep the two from drifting again.
describe("a plan item's length reads the same on every surface", () => {
  for (const sec of [1, 59, 60, 61, 599, 3599, 3600, 4500, 36000, 86399]) {
    test(`${sec} s`, () => {
      assert.equal(fmtLen(sec), fmtDuration(sec));
    });
  }

  test("4500 s is 1:15:00, not 75:00", () => {
    assert.equal(fmtLen(4500), "1:15:00");
  });

  test("an item with no length leaves the cell empty", () => {
    assert.equal(fmtLen(0), "");
    assert.equal(fmtLen(-5), "");
  });

  test("the plan total stays HH:MM:SS", () => {
    assert.equal(fmtTotal(4500), "01:15:00");
    assert.equal(fmtTotal(59), "00:00:59");
  });
});

// Each wrapper chose its options on purpose; these pin the choice at the call
// site, so deleting the option (not just the shared function) goes red.
describe("the deliberate difference each wrapper keeps", () => {
  test("a history delta never rolls minutes into hours, and zero keeps its sign", () => {
    assert.equal(fmtDelta(4500), "+75:00");
    assert.equal(fmtDelta(0), "\u00b10:00");
    assert.equal(fmtDelta(-65), "\u22121:05");
  });
  test("a recorded duration rounds and shows hours; a missing one is a dash", () => {
    assert.equal(fmtDur(59.5), "1:00");
    assert.equal(fmtDur(4500), "1:15:00");
    assert.equal(fmtDur(null), "\u2014");
  });
  test("running clocks floor: never a second early", () => {
    assert.equal(fmtClock(59_900), "0:59");
    assert.equal(formatDuration(59.9), "0:59");
    assert.equal(elapsedSince("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:59.900Z")), "0:59");
    assert.equal(formatRecordTimecode(59_900), "00:00:59");
  });
  test("the record timecode keeps HH:MM:SS", () => {
    assert.equal(formatRecordTimecode(3_723_000), "01:02:03");
  });
});
