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
    // Within the rounding the response carries (two places), not exactly — the
    // point is that it is the Leq and not the mean.
    assert.ok(Math.abs(out[0].avg - (leqOf(spiky) as number)) < 0.005, `${out[0].avg} is not the Leq`);
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

  test("INTERLEAVED rows for one bucket make ONE bucket, not two at the same t", () => {
    // The real shape, and the one a reversal does not produce: readArchiveRows
    // walks spl.csv then spl.2.csv, and a merge moves one service's rolled files
    // into another's directory — so rows for a single five-second bucket arrive
    // in two runs with other seconds in between. A streaming accumulator closes
    // its bucket the moment the index changes and emits that bucket twice, at
    // the SAME t: two points on one x, a vertical spike through the plot, and
    // double weight on whatever was in it.
    //
    // Seconds 0..9 as two files: even seconds first, then odd.
    const all = rows(10, (i) => 80 + i);
    const interleaved = [...all.filter((_, i) => i % 2 === 0), ...all.filter((_, i) => i % 2 === 1)];
    const out = bucketSeries(interleaved, "SPL A Fast", 5);

    assert.equal(out.length, 2, `${out.length} buckets for ten seconds at five`);
    assert.equal(new Set(out.map((b) => b.t)).size, out.length, "two buckets share a timestamp");
    // And they carry EVERY row, not just the run that happened to be first.
    assert.deepEqual(out.map((b) => b.max), [84, 89]);
    // Same answer as the contiguous read of the same rows.
    assert.deepEqual(out, bucketSeries(all, "SPL A Fast", 5));
  });

  test("the anchor is the earliest row, not the first one read", () => {
    // Otherwise an out-of-order file moves every bucket boundary by a few
    // seconds depending on which run was read first, and two reads of the same
    // archive answer differently.
    // Rotated by THREE, not five: a rotation that lands on a bucket boundary
    // moves every index by a whole bucket and gives the same timestamps back by
    // luck, so it proves nothing. Values vary for the same reason.
    const all = rows(10, (i) => 80 + i);
    const laterFirst = [...all.slice(3), ...all.slice(0, 3)];
    assert.deepEqual(bucketSeries(laterFirst, "SPL A Fast", 5), bucketSeries(all, "SPL A Fast", 5));
  });

  test("levels are rounded to two decimal places", () => {
    // A meter reports two. Carrying the float's full expansion put fourteen
    // significant figures of noise into every bucket of a 2,000-bucket
    // response, for a line drawn at one point per pixel.
    const out = bucketSeries(rows(5, (i) => 80 + i / 3), "SPL A Fast", 5);
    for (const b of out) {
      assert.equal(b.max, Math.round(b.max * 100) / 100, `max ${b.max}`);
      assert.equal(b.avg, Math.round(b.avg * 100) / 100, `avg ${b.avg}`);
      assert.ok(String(b.avg).replace(/^-?\d+\.?/, "").length <= 2, `avg ${b.avg} has too many places`);
    }
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
