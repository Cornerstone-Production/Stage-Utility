import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { segmentElapsedMs, isPaused } from "./baptism-elapsed.js";

const T0 = Date.parse("2026-07-26T15:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

describe("segmentElapsedMs", () => {
  test("a running segment counts from when it started", () => {
    assert.equal(segmentElapsedMs({ segmentStartedAt: at(0) }, T0 + 90_000), 90_000);
  });

  test("a paused segment holds what it banked and stops counting", () => {
    const paused = { segmentAccumMs: 90_000, segmentStartedAt: null };
    assert.equal(segmentElapsedMs(paused, T0 + 90_000), 90_000);
    // …and still reads the same ten minutes later, which is the point.
    assert.equal(segmentElapsedMs(paused, T0 + 690_000), 90_000);
  });

  test("resuming counts on from the banked total rather than restarting", () => {
    // 90s banked, resumed at t=300, read at t=330 → 120s.
    const resumed = { segmentAccumMs: 90_000, segmentStartedAt: at(300) };
    assert.equal(segmentElapsedMs(resumed, T0 + 330_000), 120_000);
  });

  test("the four-minute gap this exists for is not counted", () => {
    // Testimony runs 95s, paused through 4:30 of vows and prayer, then 20s more.
    let seg: { segmentAccumMs: number; segmentStartedAt: string | null } = { segmentAccumMs: 0, segmentStartedAt: at(0) };
    seg = { segmentAccumMs: segmentElapsedMs(seg, T0 + 95_000), segmentStartedAt: null };
    const afterGap = T0 + 95_000 + 270_000;
    seg = { ...seg, segmentStartedAt: new Date(afterGap).toISOString() };
    assert.equal(segmentElapsedMs(seg, afterGap + 20_000), 115_000, "95s + 20s, not 385s");
  });

  test("a fresh segment with nothing banked is zero", () => {
    assert.equal(segmentElapsedMs({}), 0);
    assert.equal(segmentElapsedMs({ segmentAccumMs: 0, segmentStartedAt: null }), 0);
  });

  test("a clock that went backwards does not produce a negative", () => {
    assert.equal(segmentElapsedMs({ segmentStartedAt: at(60) }, T0), 0);
  });

  test("an unparseable timestamp falls back to what was banked", () => {
    assert.equal(segmentElapsedMs({ segmentAccumMs: 5_000, segmentStartedAt: "nope" }), 5_000);
  });

  test("records made before pausing existed still read correctly", () => {
    // No accumulator at all — the old shape.
    assert.equal(segmentElapsedMs({ segmentStartedAt: at(0) }, T0 + 42_000), 42_000);
  });
});

describe("isPaused", () => {
  test("a segment with no running clock is paused", () => {
    assert.equal(isPaused({ segmentAccumMs: 1000, segmentStartedAt: null }, "testimony"), true);
  });

  test("a running segment is not", () => {
    assert.equal(isPaused({ segmentStartedAt: at(0) }, "testimony"), false);
  });

  test("idle is not paused — there is nothing to resume", () => {
    assert.equal(isPaused({ segmentStartedAt: null }, "idle"), false);
  });
});

describe("the resume bug this nearly shipped with", () => {
  test("resuming must not clear what was banked", () => {
    // The first implementation reset the accumulator on resume, so a testimony
    // paused through four minutes of prayer came back reading the length of the
    // prayer. Caught end-to-end, not by these tests — hence this one.
    const banked = { segmentAccumMs: 120_000, segmentStartedAt: null as string | null };
    const resumed = { ...banked, segmentStartedAt: at(600) };
    assert.equal(segmentElapsedMs(resumed, T0 + 610_000), 130_000, "banked 2:00 plus 10s");
    assert.notEqual(segmentElapsedMs(resumed, T0 + 610_000), 10_000, "not just the time since resuming");
  });
});
