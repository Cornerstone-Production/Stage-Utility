// Tests for the window-aware reconnect clamp.
//
// Five integrations feed their raw exponential back-off through capDelayMs, and
// three of them pass an UNBOUNDED `BASE * 2 ** attempt`. That is only safe because
// this function always returns a finite, floored delay — a regression here turns a
// quiet dormant retry into either a reconnect storm (delay collapses toward 0) or a
// dead integration that never retries (delay becomes Infinity). Both are covered.

import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";

import { serviceWindow, DEFAULT_RECONNECT_SCHEDULE } from "./service-window.js";

const MIN = 60_000;
const ACTIVE_CAP_MS = 120_000;

describe("serviceWindow.capDelayMs", () => {
  beforeEach(() => {
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
    serviceWindow.setWindows([]);
  });

  test("inside a service window the delay is capped at 2 minutes", () => {
    const now = Date.now();
    serviceWindow.setWindows([{ open: now - MIN, close: now + MIN }]);
    assert.equal(serviceWindow.capDelayMs(60 * MIN), ACTIVE_CAP_MS);
  });

  test("inside a window a short delay passes through untouched", () => {
    const now = Date.now();
    serviceWindow.setWindows([{ open: now - MIN, close: now + MIN }]);
    assert.equal(serviceWindow.capDelayMs(3000), 3000);
  });

  test("forceActive keeps an integration snappy while someone is watching it", () => {
    // No windows at all — dormant — but a client is subscribed to the channel.
    assert.equal(serviceWindow.capDelayMs(60 * MIN, true), ACTIVE_CAP_MS);
  });

  test("dormant backs off to the idle ceiling instead of the active cap", () => {
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE, dormantMin: 30 });
    assert.equal(serviceWindow.capDelayMs(60 * MIN), 30 * MIN);
  });

  test("dormant never sleeps past the next window opening", () => {
    const now = Date.now();
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE, dormantMin: 30 });
    serviceWindow.setWindows([{ open: now + 5 * MIN, close: now + 60 * MIN }]);
    const d = serviceWindow.capDelayMs(60 * MIN);
    assert.ok(d <= 5 * MIN, `expected <= 5min so the retry lands as the window opens, got ${d}ms`);
  });

  test("disabling the schedule falls back to the plain 2-minute cap", () => {
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE, enabled: false });
    assert.equal(serviceWindow.capDelayMs(60 * MIN), ACTIVE_CAP_MS);
  });

  test("the delay is floored at 1s so a retry loop can never spin hot", () => {
    assert.equal(serviceWindow.capDelayMs(0), 1000);
    assert.equal(serviceWindow.capDelayMs(-5000), 1000);
  });

  // This is the case that makes obs/smaart/reaper's unbounded `2 ** attempt` safe.
  test("an overflowed exponential back-off is clamped to a finite delay", () => {
    const overflowed = 3000 * 2 ** 1024; // === Infinity
    assert.equal(overflowed, Infinity, "precondition: the raw back-off has overflowed");

    for (const [label, setup] of [
      ["dormant, no windows known", () => serviceWindow.setWindows([])],
      ["dormant, window ahead", () => serviceWindow.setWindows([{ open: Date.now() + 10 * MIN, close: Date.now() + 60 * MIN }])],
      ["active", () => serviceWindow.setWindows([{ open: Date.now() - MIN, close: Date.now() + MIN }])],
    ] as const) {
      setup();
      const d = serviceWindow.capDelayMs(overflowed);
      assert.ok(Number.isFinite(d), `${label}: delay must stay finite, got ${d}`);
      assert.ok(d >= 1000, `${label}: delay must respect the 1s floor, got ${d}`);
    }
  });

  test("isActive is true only inside a window", () => {
    const now = Date.now();
    serviceWindow.setWindows([{ open: now + 10 * MIN, close: now + 20 * MIN }]);
    assert.equal(serviceWindow.isActive(now), false);
    assert.equal(serviceWindow.isActive(now + 15 * MIN), true);
    assert.equal(serviceWindow.isActive(now + 30 * MIN), false);
  });

  test("msUntilNextOpen is 0 inside a window and Infinity when none are known", () => {
    const now = Date.now();
    serviceWindow.setWindows([{ open: now - MIN, close: now + MIN }]);
    assert.equal(serviceWindow.msUntilNextOpen(now), 0);

    serviceWindow.setWindows([]);
    assert.equal(serviceWindow.msUntilNextOpen(now), Infinity);
  });

  test("msUntilNextOpen picks the soonest upcoming window regardless of input order", () => {
    const now = Date.now();
    serviceWindow.setWindows([
      { open: now + 50 * MIN, close: now + 60 * MIN },
      { open: now + 10 * MIN, close: now + 20 * MIN },
    ]);
    assert.equal(serviceWindow.msUntilNextOpen(now), 10 * MIN);
  });

  test("a window already in the past is ignored", () => {
    const now = Date.now();
    serviceWindow.setWindows([{ open: now - 60 * MIN, close: now - 30 * MIN }]);
    assert.equal(serviceWindow.isActive(now), false);
    assert.equal(serviceWindow.msUntilNextOpen(now), Infinity);
  });
});

// ── pollDelayMs — steady cadence, stretched when nothing is happening ───────

test("a poller keeps its normal cadence inside a service window", () => {
  const now = Date.now();
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
  serviceWindow.setWindows([{ open: now - 60_000, close: now + 600_000 }]);
  assert.equal(serviceWindow.pollDelayMs(4000, 300_000, now), 4000);
});

test("a poller backs off to the dormant ceiling outside every window", () => {
  const now = Date.now();
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
  serviceWindow.setWindows([{ open: now + 24 * 3600_000, close: now + 25 * 3600_000 }]);
  assert.equal(serviceWindow.pollDelayMs(4000, 300_000, now), 300_000);
});

test("a dormant poller never sleeps past the next window opening", () => {
  const now = Date.now();
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
  // Window opens in 90s — a 5-minute ceiling would overshoot the ramp-up.
  serviceWindow.setWindows([{ open: now + 90_000, close: now + 3600_000 }]);
  assert.equal(serviceWindow.pollDelayMs(4000, 300_000, now), 90_000);
});

test("with no windows known the poller stays awake, rather than going quiet", () => {
  // No PCO credentials, or the schedule fetch failed. Going dormant because we
  // could not work out the schedule is how a service gets missed.
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
  serviceWindow.setWindows([]);
  assert.equal(serviceWindow.pollDelayMs(4000, 300_000, Date.now()), 4000);
});

test("with the feature switched off the poller is untouched", () => {
  const now = Date.now();
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE, enabled: false });
  serviceWindow.setWindows([{ open: now + 24 * 3600_000, close: now + 25 * 3600_000 }]);
  assert.equal(serviceWindow.pollDelayMs(4000, 300_000, now), 4000);
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
});

test("the dormant delay is never shorter than the active cadence", () => {
  const now = Date.now();
  serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
  serviceWindow.setWindows([{ open: now + 500, close: now + 3600_000 }]);
  assert.ok(serviceWindow.pollDelayMs(4000, 300_000, now) >= 4000);
});
