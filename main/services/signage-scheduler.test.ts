// When the scheduler talks, and when it wakes up.
//
// Both halves are about not being noisy. Broadcast-on-change is the standing
// rule for anything new here: an identical map pushed on a timer wakes every
// display for nothing, on a network that also carries the countdown and the
// slot telemetry.
//
// The wake-up half is the reason the horizon exists at all. The scheduler arms
// ONE timeout at the next instant any window could change its answer, rather
// than polling every second and diffing. The two failure modes worth pinning are
// a timer that never fires (a boundary hours away with no safety net) and one
// that fires immediately forever (a boundary already in the past).

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageHorizon } from "../types/signage.js";
import { SAFETY_TICK_MS, nextWakeMs, shouldBroadcast } from "./signage-scheduler.js";

const NOW = 1_000_000;
const entry = (from: number, until: number, reasonLabel = "") =>
  ({ from, until, reason: "blank", reasonLabel }) as never;

describe("when the scheduler talks", () => {
  test("stays quiet when nothing changed", () => {
    const a: Record<string, SignageHorizon> = { "out-1": [entry(1, 2)] };
    const b: Record<string, SignageHorizon> = { "out-1": [entry(1, 2)] };
    assert.equal(shouldBroadcast(a, b), false);
  });

  test("talks when an output's horizon differs", () => {
    assert.equal(
      shouldBroadcast({ "out-1": [entry(1, 2)] }, { "out-1": [entry(1, 3)] }),
      true,
    );
  });

  test("talks when only the REASON changed", () => {
    // Same playlist, different winning schedule. The board says why, so this is
    // a real change even though the wall looks identical.
    assert.equal(
      shouldBroadcast({ "out-1": [entry(1, 2, "Weekend")] }, { "out-1": [entry(1, 2, "Office")] }),
      true,
    );
  });

  test("talks when an output appears or disappears", () => {
    assert.equal(shouldBroadcast({}, { "out-1": [] }), true);
    assert.equal(shouldBroadcast({ "out-1": [] }, {}), true);
  });

  test("does not talk merely because the object identity changed", () => {
    // Every recompute builds a fresh map; comparing by reference would broadcast
    // on every tick forever.
    const shape = () => ({ "out-1": [entry(1, 2, "Weekend")] });
    assert.equal(shouldBroadcast(shape(), shape()), false);
  });

  test("talks on the very first computation", () => {
    assert.equal(shouldBroadcast(null, { "out-1": [entry(1, 2)] }), true);
  });
});

describe("when the scheduler wakes up", () => {
  test("at the earliest boundary across every output", () => {
    const h: Record<string, SignageHorizon> = {
      "out-1": [entry(NOW, NOW + 90_000)],
      "out-2": [entry(NOW, NOW + 30_000)],
    };
    assert.equal(nextWakeMs(h, NOW), 30_000);
  });

  test("never later than the safety tick", () => {
    // A horizon whose first boundary is hours away must still be re-checked: PCO
    // windows and the live state change outside this module, and a wall stale
    // all afternoon is worse than a wake-up a minute.
    const h: Record<string, SignageHorizon> = { "out-1": [entry(NOW, NOW + 8 * 3600_000)] };
    assert.equal(nextWakeMs(h, NOW), SAFETY_TICK_MS);
  });

  test("never zero or negative, however stale the horizon is", () => {
    // A boundary already in the past would arm a zero-delay timer that re-arms
    // itself immediately - a busy loop on a Pi.
    const h: Record<string, SignageHorizon> = { "out-1": [entry(NOW - 10_000, NOW - 5_000)] };
    const wake = nextWakeMs(h, NOW);
    assert.ok(wake > 0, `the scheduler would spin: ${wake}`);
  });

  test("with no outputs at all, still the safety tick", () => {
    assert.equal(nextWakeMs({}, NOW), SAFETY_TICK_MS);
  });

  test("with an empty horizon for an output, still the safety tick", () => {
    assert.equal(nextWakeMs({ "out-1": [] }, NOW), SAFETY_TICK_MS);
  });

  test("looks past an entry that has already ended", () => {
    // The first entry is stale; the real next boundary is the second one's end.
    const h: Record<string, SignageHorizon> = {
      "out-1": [entry(NOW - 10_000, NOW - 5_000), entry(NOW - 5_000, NOW + 20_000)],
    };
    assert.equal(nextWakeMs(h, NOW), 20_000);
  });
});
