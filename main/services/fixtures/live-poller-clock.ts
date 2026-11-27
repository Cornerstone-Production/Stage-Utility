// live-poller-clock.ts — fake time for tests that drive the real live poller.
//
// Imports no service module on purpose: the tests set STAGE_UTILITY_DATA before
// they import the poller, and a fixture that pulled a store in first would point
// it at the real data dir.

import type { TestContext } from "node:test";

/** Let a tick's awaits run. setImmediate is not one of the faked timers. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

let base = Date.UTC(2026, 8, 20, 15);

/**
 * Fake setTimeout, setInterval and Date for one case; node:test puts the real
 * ones back when it ends.
 *
 * Each case starts an hour after the last. The poller is a module singleton, so
 * its last-broadcast stamp survives into the next case, and with a clock that
 * did not move the keepalive would see a push moments old.
 */
export function fakeTime(t: TestContext): void {
  base += 3_600_000;
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: base });
}

/** Advance fake time a second at a time, letting each tick that falls due finish. */
export async function advance(t: TestContext, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1_000) {
    t.mock.timers.tick(Math.min(1_000, left));
    await settle();
  }
}
