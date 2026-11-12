import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { effectiveSoundMetric, peakOn, soundMetricOptions } from "./sound-metric";

const firstOf = (a: readonly string[]) => a[0] ?? null;

describe("soundMetricOptions", () => {
  test("is every key any summary carries, once, and none hidden", () => {
    assert.deepEqual(
      soundMetricOptions([["LAeq 2", "SPL Fast"], ["LCeq 2", "LAeq 2"], []]),
      ["LAeq 2", "LCeq 2", "SPL Fast"],
    );
  });

  test("sorts numerically, so LAeq 2 comes before LAeq 10", () => {
    assert.deepEqual(soundMetricOptions([["LAeq 10", "LAeq 2", "LAeq 1"]]), ["LAeq 1", "LAeq 2", "LAeq 10"]);
  });

  test("is the same order whatever order the summaries arrive in", () => {
    const a = soundMetricOptions([["SPL Fast", "LAeq 1"], ["LCeq 2"]]);
    const b = soundMetricOptions([["LCeq 2"], ["LAeq 1", "SPL Fast"]]);
    assert.deepEqual(a, b);
  });

  test("ties numeric collation leaves still sort the same whatever the arrival order", () => {
    // "LAeq 2" and "LAeq 02" collate equal under { numeric: true }.
    assert.deepEqual(soundMetricOptions([["LAeq 2"], ["LAeq 02"]]), soundMetricOptions([["LAeq 02"], ["LAeq 2"]]));
  });

  test("offers no key the server would refuse to save", () => {
    assert.deepEqual(
      soundMetricOptions([["LAeq 2", " LAeq 2", "LAeq\n2", "x".repeat(49), "Peak [C]"]]),
      ["LAeq 2"],
    );
  });

  test("offers every metric name production carries today", () => {
    const PRODUCTION = [
      "FS Peak",
      "LAeq 1",
      "LAeq 2",
      "LCeq 1",
      "LCeq 2",
      "Leq 1",
      "Leq 2",
      "Peak C",
      "SPL A Fast",
      "SPL A Slow",
      "SPL C Fast",
      "SPL C Slow",
      "SPL Fast",
      "SPL Slow",
    ];
    assert.deepEqual([...soundMetricOptions([PRODUCTION])].sort(), PRODUCTION);
  });

  test("is empty when nothing carries a metric", () => {
    assert.deepEqual(soundMetricOptions([]), []);
  });
});

describe("effectiveSoundMetric", () => {
  test("a saved choice wins, even over LAeq 2", () => {
    assert.equal(effectiveSoundMetric("LCeq 2", ["LAeq 2", "LCeq 2"], firstOf), "LCeq 2");
  });

  test("a saved choice nothing carries is kept, not swapped for a neighbour", () => {
    assert.equal(effectiveSoundMetric("LCeq 2", ["LAeq 2"], firstOf), "LCeq 2");
  });

  test("with nothing saved: LAeq 2 when carried", () => {
    assert.equal(effectiveSoundMetric(null, ["LAeq 1", "LAeq 2", "SPL A Slow"], () => "SPL A Slow"), "LAeq 2");
  });

  test("with nothing saved and no LAeq 2: LAeq 1", () => {
    assert.equal(effectiveSoundMetric(null, ["LAeq 1", "SPL A Slow"], () => "SPL A Slow"), "LAeq 1");
  });

  test("with neither: the fallback rule decides, and is handed what is available", () => {
    let seen: readonly string[] = [];
    const got = effectiveSoundMetric(null, ["LCeq 2", "SPL Fast"], (a) => ((seen = a), "SPL Fast"));
    assert.equal(got, "SPL Fast");
    assert.deepEqual(seen, ["LCeq 2", "SPL Fast"]);
  });

  test("nothing available and nothing saved is null", () => {
    assert.equal(effectiveSoundMetric(null, [], firstOf), null);
  });

  test("with no fallback given, the first metric available decides: the one default both callers use", () => {
    assert.equal(effectiveSoundMetric(null, ["LCeq 2", "SPL Fast"]), "LCeq 2");
    assert.equal(effectiveSoundMetric(null, []), null);
  });
});

describe("peakOn", () => {
  const metrics = { "LAeq 2": { max: 95.4 }, "SPL Fast": { max: null }, "LCeq 2": {} };

  test("is the metric's own peak", () => {
    assert.equal(peakOn(metrics, "LAeq 2"), 95.4);
  });

  test("a recording without the metric contributes nothing, not another metric's figure", () => {
    assert.equal(peakOn(metrics, "LAeq 1"), null);
    assert.equal(peakOn(metrics, "SPL Fast"), null);
    assert.equal(peakOn(metrics, "LCeq 2"), null);
  });

  test("no metric is no peak", () => {
    assert.equal(peakOn(metrics, null), null);
  });
});
