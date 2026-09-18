// spl-series.test.ts — the bucket maths behind the sound chart's line.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { MAX_BUCKETS, bucketSecFor, bucketSeries, clampBucketSec, metricsIn } from "./spl-series.js";
import { leqOf } from "./spl-leq.js";
import type { ArchiveRow } from "./archive/archive-rows.js";

const T0 = Date.parse("2026-09-17T20:00:00.000Z");

/** `n` rows one second apart, `value(i)` dB on the named metric. */
function rows(n: number, value: (i: number) => number, metric = "SPL A Fast"): ArchiveRow[] {
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(T0 + i * 1000).toISOString(),
    itemId: "a",
    item: "Message",
    [metric]: String(value(i)),
  }));
}

describe("clampBucketSec", () => {
  test("keeps a sane request", () => {
    assert.equal(clampBucketSec(5), 5);
    assert.equal(clampBucketSec(30), 30);
  });

  test("nonsense falls back to five seconds, never to zero", () => {
    // Zero is the dangerous one: it is a division by zero one line later.
    for (const bad of [0, -3, NaN, "abc", null, undefined, {}]) {
      assert.equal(clampBucketSec(bad), 5, `${String(bad)} did not fall back`);
    }
  });

  test("held inside the accepted range", () => {
    assert.equal(clampBucketSec(100000), 600);
    // A sub-second ask is a real ask, just finer than the raw rows are — it
    // clamps to the floor of one second rather than to the default.
    assert.equal(clampBucketSec(0.2), 1);
  });
});

describe("bucketSecFor", () => {
  test("a request that fits is honoured", () => {
    // Two hours at five seconds is 1,440 buckets — inside the cap.
    assert.equal(bucketSecFor(2 * 60 * 60_000, 5), 5);
  });

  test("a request that does not fit is WIDENED, never truncated", () => {
    // Eight hours at one second would be 28,800. A chart that silently stopped
    // before the sermon would be worse than a coarser one.
    const widened = bucketSecFor(8 * 60 * 60_000, 1);
    assert.ok(widened > 1, `stayed at ${widened}`);
    assert.ok((8 * 60 * 60) / widened <= MAX_BUCKETS, `${(8 * 60 * 60) / widened} buckets`);
  });

  test("the cap is respected for every span a service can have", () => {
    for (const hours of [0.5, 1, 2, 4, 8, 24]) {
      const span = hours * 60 * 60_000;
      const sec = bucketSecFor(span, 1);
      assert.ok(span / 1000 / sec <= MAX_BUCKETS, `${hours}h gave ${span / 1000 / sec} buckets`);
    }
  });

  test("an empty window does not divide by zero", () => {
    assert.equal(bucketSecFor(0, 5), 5);
  });
});

describe("bucketSeries", () => {
  test("one bucket per window, with the loudest reading in it", () => {
    // 20 seconds, 5s buckets → 4. Value climbs, so each bucket's max is its last.
    const out = bucketSeries(rows(20, (i) => 80 + i), "SPL A Fast", 5);
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((b) => b.max), [84, 89, 94, 99]);
  });

  test("the average is the ENERGY average, not the arithmetic mean", () => {
    // A quiet bucket with one loud spike. The arithmetic mean is 84; the Leq is
    // ~92, because the spike carries almost all the energy. Getting this wrong
    // is the exact mistake spl-leq.ts exists to prevent.
    const spiky = [80, 80, 80, 80, 100];
    const out = bucketSeries(rows(5, (i) => spiky[i]), "SPL A Fast", 5);
    assert.equal(out.length, 1);
    const arithmetic = spiky.reduce((a, b) => a + b, 0) / spiky.length;
    assert.ok(Math.abs(out[0].avg - (leqOf(spiky) as number)) < 1e-9, `${out[0].avg} is not the Leq`);
    assert.ok(out[0].avg - arithmetic > 5, `${out[0].avg} is too close to the arithmetic ${arithmetic}`);
  });

  test("buckets are anchored to the first row, not to the wall clock", () => {
    // A service beginning at 19:47:13 must not open with a part-empty bucket.
    const offset = rows(10, () => 90).map((r, i) => ({
      ...r,
      at: new Date(Date.parse("2026-09-17T19:47:13.000Z") + i * 1000).toISOString(),
    }));
    const out = bucketSeries(offset, "SPL A Fast", 5);
    assert.equal(new Date(out[0].t).toISOString(), "2026-09-17T19:47:13.000Z");
  });

  test("a bucket the meter said nothing in is ABSENT, not zero", () => {
    // A 0 dB sample would spike the line to the floor of the plot through a
    // minute the meter was simply unreachable.
    const withHole = [
      ...rows(5, () => 90),
      ...rows(5, () => 90).map((r, i) => ({
        ...r,
        at: new Date(T0 + (60 + i) * 1000).toISOString(),
      })),
    ];
    const out = bucketSeries(withHole, "SPL A Fast", 5);
    // Two buckets, one either side of the hole — NOT the eleven a range-filling
    // implementation would emit, nine of them at zero. The count is the
    // assertion that catches it; `every(avg > 0)` alone passes on an
    // implementation that never opens an empty bucket in the first place.
    assert.equal(out.length, 2, `${out.length} buckets across a 55-second hole`);
    assert.ok(out.every((b) => b.avg > 0), "a hole came back as a zero bucket");
    assert.equal((out[1].t - out[0].t) / 1000, 60);
  });

  test("a metric the rows do not carry gives nothing rather than NaN", () => {
    assert.deepEqual(bucketSeries(rows(10, () => 90), "LCeq", 5), []);
  });

  test("blank and unparseable cells are skipped, not counted", () => {
    // Twelve seconds, 5s buckets, every other cell blank: three buckets, and the
    // blanks neither create a bucket of their own nor pull an average down.
    const mixed = rows(12, () => 90).map((r, i) => (i % 2 ? { ...r, "SPL A Fast": "" } : r));
    const out = bucketSeries(mixed, "SPL A Fast", 5);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((b) => b.max), [90, 90, 90]);
    assert.deepEqual(out.map((b) => Math.round(b.avg)), [90, 90, 90]);
  });

  test("a row with no parsable stamp is skipped rather than anchoring at the epoch", () => {
    const bad = [{ at: "not a date", itemId: "a", item: "x", "SPL A Fast": "90" }, ...rows(5, () => 88)];
    const out = bucketSeries(bad, "SPL A Fast", 5);
    assert.equal(out.length, 1);
    assert.equal(new Date(out[0].t).toISOString(), new Date(T0).toISOString());
  });

  test("the result is in time order even when the rows are not", () => {
    // A rolled file can land out of order after a merge; an unsorted series
    // draws as a scribble rather than as a line.
    const shuffled = [...rows(20, (i) => 80 + i)].reverse();
    const out = bucketSeries(shuffled, "SPL A Fast", 5);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t, "out of order");
  });

  test("nothing in, nothing out", () => {
    assert.deepEqual(bucketSeries([], "SPL A Fast", 5), []);
  });
});

describe("metricsIn", () => {
  test("every metric column, sorted, and none of the three fixed ones", () => {
    const r: ArchiveRow[] = [
      { at: new Date(T0).toISOString(), itemId: "a", item: "x", "SPL A Fast": "90", "LAeq 1": "85" },
      { at: new Date(T0 + 1000).toISOString(), itemId: "a", item: "x", LCeq: "95" },
    ];
    assert.deepEqual(metricsIn(r), ["LAeq 1", "LCeq", "SPL A Fast"]);
  });

  test("a column that is blank everywhere is not a metric", () => {
    const r: ArchiveRow[] = [{ at: new Date(T0).toISOString(), itemId: "a", item: "x", LCeq: "", "SPL A Fast": "90" }];
    assert.deepEqual(metricsIn(r), ["SPL A Fast"]);
  });
});
