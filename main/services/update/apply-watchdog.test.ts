import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApplyWatchdog, STALL_TIMEOUT_MS } from "./apply-watchdog.js";

// The bug: an apply that dies without writing a result file leaves the UI on
// "Downloading update… 20%" indefinitely. Watched happen on a real box — the
// script's working directory was deleted underneath it, every remaining command
// failed, and nothing reported. A reload did not help: the phase itself still
// said an update was running.

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe("ApplyWatchdog", () => {
  it("says nothing is wrong before an apply starts", () => {
    const w = new ApplyWatchdog();
    // Never begun: an idle server must not declare a stall it is not having.
    assert.equal(w.stalled(T0 + 10 * STALL_TIMEOUT_MS), false);
  });

  it("declares a silent run dead once the timeout passes", () => {
    const w = new ApplyWatchdog();
    w.begin(T0);
    assert.equal(w.stalled(T0 + STALL_TIMEOUT_MS - 1), false, "not one millisecond early");
    assert.equal(w.stalled(T0 + STALL_TIMEOUT_MS), true);
  });

  it("a slow but LIVE update is never declared dead", () => {
    // A church DSL line downloading 128 MB is not a failure. Only silence is.
    const w = new ApplyWatchdog();
    w.begin(T0);
    let now = T0;
    for (let i = 0; i < 12; i++) {
      now += 9 * MIN; // just inside the window, repeatedly
      assert.equal(w.stalled(now), false, `still writing at minute ${(now - T0) / MIN}`);
      w.progress(now);
    }
    // Over an hour and a half of real work, never falsely killed.
    assert.ok(now - T0 > 90 * MIN);
  });

  it("the clock runs from the last sign of life, not from the start", () => {
    const w = new ApplyWatchdog();
    w.begin(T0);
    w.progress(T0 + 30 * MIN);
    assert.equal(w.stalled(T0 + 35 * MIN), false, "5 minutes of silence is not a stall");
    assert.equal(w.stalled(T0 + 41 * MIN), true, "11 minutes after the last write is");
  });

  it("stops watching once the run ends, so a finished apply cannot stall later", () => {
    const w = new ApplyWatchdog();
    w.begin(T0);
    w.end();
    assert.equal(w.stalled(T0 + 10 * STALL_TIMEOUT_MS), false);
  });

  it("reports the silence in minutes, for the operator-facing message", () => {
    const w = new ApplyWatchdog();
    w.begin(T0);
    assert.equal(w.silentFor(T0 + 1 * MIN), "1 minute");
    assert.equal(w.silentFor(T0 + 12 * MIN), "12 minutes");
  });
});
