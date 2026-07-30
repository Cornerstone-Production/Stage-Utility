import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { advancePeakHold, type PeakHold } from "./peak-hold.js";

const start = (key = "a", peak: number | null = null): PeakHold => ({ key, peak });

describe("advancePeakHold", () => {
  test("the first sample becomes the peak", () => {
    assert.deepEqual(advancePeakHold(start(), "a", 92.5, true), { key: "a", peak: 92.5 });
  });

  test("a louder sample raises the hold", () => {
    assert.deepEqual(advancePeakHold(start("a", 92.5), "a", 97, true), { key: "a", peak: 97 });
  });

  test("a quieter sample leaves the hold alone — that is the point of it", () => {
    const hold = start("a", 97);
    assert.equal(advancePeakHold(hold, "a", 80, true), hold, "must be the same object, or it re-renders forever");
  });

  test("a gap in the signal holds rather than resetting", () => {
    const hold = start("a", 97);
    assert.equal(advancePeakHold(hold, "a", null, true), hold);
  });

  test("changing meter or metric drops the previous source's peak", () => {
    // The reset and the new sample land together; the old peak must not survive.
    assert.deepEqual(advancePeakHold(start("a", 120), "b", 70, true), { key: "b", peak: 70 });
  });

  test("changing source with no reading yet clears to nothing", () => {
    assert.deepEqual(advancePeakHold(start("a", 120), "b", null, true), { key: "b", peak: null });
  });

  test("with hold off the peak stops accumulating", () => {
    const hold = start("a", 90);
    assert.equal(advancePeakHold(hold, "a", 200, false), hold, "a live reading must not raise a disabled hold");
  });

  test("applying it twice changes nothing — this is what guarantees render convergence", () => {
    let hold = start();
    for (const sample of [80, 95, 91, 95.5, null, 40]) {
      const once = advancePeakHold(hold, "a", sample, true);
      const twice = advancePeakHold(once, "a", sample, true);
      assert.equal(twice, once, `re-applying sample ${sample} produced a new object`);
      hold = once;
    }
    assert.equal(hold.peak, 95.5, "the loop should have settled on the loudest sample");
  });

  test("a repeated key change is stable too", () => {
    const first = advancePeakHold(start("a", 120), "b", 70, true);
    assert.equal(advancePeakHold(first, "b", 70, true), first);
  });
});
