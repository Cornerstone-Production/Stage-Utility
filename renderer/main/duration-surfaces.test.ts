import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fmtLen, fmtTotal } from "./servicecue-columns.js";
import { fmtDuration } from "./pco-timer.js";

// One datum, one string. A plan item of 4500 s printed "75:00" in the ServiceCue
// Length column and "1:15:00" in the layout rundown and on Home; the shared
// formatter is the only thing that can keep the two from drifting again.
describe("a plan item's length reads the same on every surface", () => {
  for (const sec of [1, 59, 60, 61, 599, 3599, 3600, 4500, 36000]) {
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
