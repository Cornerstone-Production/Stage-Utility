// A recovery is said once it has held for the settle window (integration-base.ts,
// noteHealthy). The window is a timer started by resetBackoff() on a success, and
// cancelled by a failure. Some integrations call resetBackoff() on every successful
// poll, not only on the one that ends an outage: ProPresenter's fallback poll every
// 5 s, SenSource's poll, ProdCom's WebSocket on every frame. Each call re-armed the
// two-minute timer, so with a poll faster than the window it never fired: "reachable
// again" was never logged, the outage never ended, and the next one read "still
// failing after 2 attempts (360 min)". A pending timer is not re-armed now.
//
// Driven through a bare ConnectionLifecycle subclass, with setTimeout and Date
// mocked, so the window is walked without waiting.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ConnectionLifecycle } from "./integration-base.js";

class Probe extends ConnectionLifecycle {
  constructor() {
    super("settle-probe", "settle-probe:test");
  }
  protected get configured(): boolean {
    return true;
  }
  protected async connect(): Promise<void> {}
  fail(): void {
    this.noteOutage("cannot reach the probe");
  }
  ok(): void {
    this.resetBackoff();
  }
}

test("a success on every poll, faster than the settle window, still ends the outage", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const lines: string[] = [];
  const { warn, log } = console;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = console.warn;
  const probe = new Probe();
  try {
    probe.start();
    probe.fail();
    // Three minutes of good polls, one every 5 s, each calling resetBackoff().
    for (let s = 0; s < 180; s += 5) {
      t.mock.timers.tick(5_000);
      probe.ok();
    }
  } finally {
    probe.stop();
    console.warn = warn;
    console.log = log;
  }
  assert.equal(lines.filter((l) => l.startsWith("[settle-probe] reachable again")).length, 1, JSON.stringify(lines));
});

test("a failure inside the window still cancels it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const lines: string[] = [];
  const { warn, log } = console;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.log = console.warn;
  const probe = new Probe();
  try {
    probe.start();
    probe.fail();
    for (let s = 0; s < 180; s += 5) {
      t.mock.timers.tick(5_000);
      // A flap every minute: never two minutes clear of a failure.
      if (s % 60 === 55) probe.fail();
      else probe.ok();
    }
  } finally {
    probe.stop();
    console.warn = warn;
    console.log = log;
  }
  assert.equal(lines.filter((l) => l.includes("reachable again")).length, 0, JSON.stringify(lines));
});
