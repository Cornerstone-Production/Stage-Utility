import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { addLeqSample, combineLeq, leqOf } from "./spl-leq.js";

/** Fold a whole series through the incremental form, the way the recorder does. */
function accumulate(samples: readonly number[]): number | null {
  let leq: number | null = null;
  let count = 0;
  for (const s of samples) {
    leq = addLeqSample(leq, count, s);
    count += 1;
  }
  return leq;
}

const near = (a: number | null, b: number | null, msg: string) => {
  assert.ok(a != null && b != null, msg);
  assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
};

describe("leqOf", () => {
  test("a steady level averages to itself", () => {
    near(leqOf([90, 90, 90, 90]), 90, "steady");
  });

  test("doubling the energy is +3 dB", () => {
    // Two sources at 90 dB together make 93 dB; as an average of one 90 and one
    // 93 sample the energy mean sits between, not at the arithmetic 91.5.
    near(leqOf([90, 90]), 90, "same level");
    assert.ok(leqOf([90, 96])! > 93.5, "the louder sample must dominate");
  });

  test("loud moments dominate, which is the whole point", () => {
    // The case that motivated this: mostly quiet, one loud passage.
    const samples = [82, 82, 83, 82, 84, 83, 102, 101, 84, 83];
    const arithmetic = samples.reduce((a, b) => a + b, 0) / samples.length;
    const energy = leqOf(samples)!;
    assert.ok(energy > arithmetic + 5, `energy ${energy} should far exceed mean ${arithmetic}`);
    assert.ok(energy < 102, "but must not exceed the loudest sample");
  });

  test("never exceeds the maximum or falls below the minimum", () => {
    for (const s of [[70, 80, 90], [100, 60], [88], [95, 95.5, 94]]) {
      const e = leqOf(s)!;
      assert.ok(e <= Math.max(...s) + 1e-9, `${e} <= max`);
      assert.ok(e >= Math.min(...s) - 1e-9, `${e} >= min`);
    }
  });

  test("no samples means no level, rather than zero", () => {
    assert.equal(leqOf([]), null);
  });

  test("non-finite readings are skipped, not poisoning the result", () => {
    near(leqOf([90, Number.NaN, 90]), 90, "NaN ignored");
  });
});

describe("addLeqSample", () => {
  test("the incremental form matches the whole-series formula", () => {
    for (const series of [
      [82, 82, 83, 82, 84, 83, 102, 101, 84, 83],
      [95, 96, 95, 97, 96, 95, 96, 95],
      [70, 70, 71, 70, 99, 98, 70, 71],
      [88],
    ]) {
      near(accumulate(series), leqOf(series), `series ${series.length} long`);
    }
  });

  test("order does not change the answer", () => {
    const s = [82, 102, 83, 101, 84];
    near(accumulate(s), accumulate([...s].reverse()), "reversed");
    near(accumulate(s), accumulate([...s].sort((a, b) => a - b)), "sorted");
  });

  test("the first sample is the level", () => {
    assert.equal(addLeqSample(null, 0, 93.5), 93.5);
  });

  test("a count of zero starts over rather than dividing by it", () => {
    assert.equal(addLeqSample(120, 0, 80), 80);
  });

  test("it is not the arithmetic mean — the bug this replaces", () => {
    // 85, 85, 100 → arithmetic 90.0, energy ~95.5. If this ever equals 90 the
    // recorder has regressed to averaging decibels linearly.
    const energy = accumulate([85, 85, 100])!;
    assert.ok(Math.abs(energy - 90) > 5, `got ${energy}, which is the arithmetic mean`);
    near(energy, leqOf([85, 85, 100]), "matches the reference");
  });

  test("a non-finite reading leaves the running level untouched", () => {
    assert.equal(addLeqSample(91, 5, Number.NaN), 91);
  });
});

describe("combining per-item Leqs into a service level", () => {
  test("matches leqOf over the same samples, weights and all", () => {
    // The reference. Three items of very different lengths and levels; folding
    // their Leqs with their sample counts must land on the level you would get
    // by keeping every sample and averaging once.
    const items = [
      Array.from({ length: 5 }, () => 70),
      Array.from({ length: 200 }, () => 95),
      Array.from({ length: 40 }, () => 82),
    ];
    const parts = items.map((xs) => ({ leq: leqOf(xs), count: xs.length }));
    const combined = combineLeq(parts);
    const direct = leqOf(items.flat());
    assert.ok(combined != null && direct != null);
    assert.ok(Math.abs(combined - direct) < 1e-9, `${combined} vs ${direct}`);
  });

  test("the weights are the point — a short quiet item cannot cancel a long loud one", () => {
    // The failure this exists for: an unweighted mean of these two Leqs is 82.5,
    // which is 12 dB below what anybody in the room heard for all but five
    // seconds of it. Averaging Leqs evenly is the same class of mistake as
    // averaging dB arithmetically, one level up.
    const weighted = combineLeq([
      { leq: 70, count: 5 },
      { leq: 95, count: 600 },
    ]);
    assert.ok(weighted != null);
    assert.ok(weighted > 94, `expected the long loud item to dominate, got ${weighted}`);
    const unweighted = (70 + 95) / 2;
    assert.ok(weighted - unweighted > 10, "an even average would understate this by more than 10 dB");
  });

  test("items the meter never reported during are skipped, not counted as silence", () => {
    // A null is "no reading", not 0 dB. Counting it as zero would drag a service
    // average down by an item that was simply not measured.
    const withGap = combineLeq([
      { leq: 90, count: 100 },
      { leq: null, count: 100 },
      { leq: undefined, count: 100 },
    ]);
    assert.equal(withGap, 90);
  });

  test("a zero-sample part carries no weight even when it has a level", () => {
    assert.equal(combineLeq([{ leq: 90, count: 100 }, { leq: 60, count: 0 }]), 90);
  });

  test("nothing to combine is null, not zero", () => {
    assert.equal(combineLeq([]), null);
    assert.equal(combineLeq([{ leq: null, count: 10 }]), null);
    assert.equal(combineLeq([{ leq: 90, count: 0 }]), null);
  });
});
