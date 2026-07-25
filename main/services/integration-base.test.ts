// Tests for the shared integration lifecycle.
//
// This class now sits under every LAN integration, so a regression here breaks
// all of them at once — and the failure mode is silent (an integration that
// stops retrying, or one that retries in a hot loop against gear that is simply
// powered off). The properties pinned below are the ones the services rely on.

import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";

import { addBroadcastListener } from "./broadcaster.js";
import { StatusIntegration, type ConnState } from "./integration-base.js";
import { serviceWindow, DEFAULT_RECONNECT_SCHEDULE } from "./service-window.js";

interface Dto { connected: boolean; value: number }
const OFFLINE: Dto = { connected: false, value: 0 };

/** A StatusIntegration whose connect() succeeds or fails on command. */
class Fake extends StatusIntegration<Dto> {
  attempts = 0;
  shouldFail = false;
  ready = true;
  torn = 0;

  constructor(channel = "fake:status") { super("fake", channel, OFFLINE); }

  protected get configured(): boolean { return this.ready; }
  protected override teardown(): void { this.torn++; }

  protected async connect(): Promise<void> {
    this.attempts++;
    if (this.shouldFail) {
      this.report("error", "nope");
      this.goOffline();
      this.scheduleReconnect();
      return;
    }
    this.resetBackoff();
    this.report("connected", "ok");
    this.emit({ connected: true, value: this.attempts });
  }

  // Surface protected bits the tests need to observe.
  get attemptCount(): number { return this.attempt; }
  callScheduleIn(ms: number): void { this.scheduleIn(ms); }
  stopTimers(): void { this.clearReconnect(); }
}

describe("ConnectionLifecycle", () => {
  beforeEach(() => {
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
    // An active window keeps delays at the 2-min cap — long enough that no
    // retry fires during a test, so these assertions never race a timer.
    const now = Date.now();
    serviceWindow.setWindows([{ open: now - 60_000, close: now + 600_000 }]);
  });

  test("start() connects when configured", async () => {
    const f = new Fake();
    f.start();
    await Promise.resolve();
    assert.equal(f.attempts, 1);
    f.stop();
  });

  test("start() is a no-op when not configured", async () => {
    const f = new Fake();
    f.ready = false;
    f.start();
    await Promise.resolve();
    assert.equal(f.attempts, 0, "an unconfigured integration must not dial out");
  });

  test("start() is idempotent — a second call does not double-connect", async () => {
    const f = new Fake();
    f.start();
    f.start();
    await Promise.resolve();
    assert.equal(f.attempts, 1);
    f.stop();
  });

  test("stop() runs the subclass teardown", () => {
    const f = new Fake();
    f.start();
    f.stop();
    assert.equal(f.torn, 1);
  });

  test("scheduleReconnect does nothing once stopped", async () => {
    const f = new Fake();
    f.shouldFail = true;
    f.start();
    await Promise.resolve();
    const after = f.attempts;
    f.stop();
    f.callScheduleIn(1); // must be ignored — not running
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.attempts, after, "a stopped integration must never reconnect");
  });

  test("scheduleIn replaces the pending timer rather than stacking one", async () => {
    const f = new Fake();
    f.start();
    await Promise.resolve();
    f.callScheduleIn(5);
    f.callScheduleIn(5);
    f.callScheduleIn(5);
    await new Promise((r) => setTimeout(r, 40));
    // Exactly one further connect, not three — this is what keeps REAPER's poll
    // from multiplying every time it reconnects.
    assert.equal(f.attempts, 2, `expected one queued retry, got ${f.attempts - 1}`);
    f.stop();
  });

  test("a successful connect resets the back-off", async () => {
    const f = new Fake();
    f.shouldFail = true;
    f.start();
    await Promise.resolve();
    assert.equal(f.attemptCount, 1, "one failure recorded");

    f.shouldFail = false;
    f.stopTimers();
    f.callScheduleIn(1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.attemptCount, 0, "a success must clear the back-off counter");
    f.stop();
  });

  test("repeat reports of the same state are suppressed", async () => {
    const seen: ConnState[] = [];
    const f = new Fake();
    f.setConnectionListener((s) => seen.push(s));
    f.start();
    await Promise.resolve();
    f.stopTimers();
    f.callScheduleIn(1);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(seen, ["connected"], "a quiet retry loop must not spam the panel");
    f.stop();
  });

  test("a state change is reported", async () => {
    const seen: ConnState[] = [];
    const f = new Fake();
    f.setConnectionListener((s) => seen.push(s));
    f.start();
    await Promise.resolve();
    f.shouldFail = true;
    f.stopTimers();
    f.callScheduleIn(1);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(seen, ["connected", "error"]);
    f.stop();
  });
});

describe("StatusIntegration", () => {
  beforeEach(() => {
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
    const now = Date.now();
    serviceWindow.setWindows([{ open: now - 60_000, close: now + 600_000 }]);
  });

  test("getLatest starts at the OFFLINE snapshot", () => {
    assert.deepEqual(new Fake().getLatest(), OFFLINE);
  });

  test("getLatest reflects the last emit, so a new display hydrates immediately", async () => {
    const f = new Fake();
    f.start();
    await Promise.resolve();
    assert.deepEqual(f.getLatest(), { connected: true, value: 1 });
    f.stop();
  });

  test("stop() drops the snapshot back to OFFLINE", async () => {
    const f = new Fake();
    f.start();
    await Promise.resolve();
    f.stop();
    assert.deepEqual(f.getLatest(), OFFLINE, "a stopped integration must not look connected");
  });

  test("goOffline does not re-broadcast when already offline", async () => {
    // Guards against spraying an identical offline snapshot onto the SSE channel
    // on every failed retry while gear is powered down all week. Counting the
    // broadcasts is the only way to see this — the snapshot itself is unchanged
    // either way, so comparing getLatest() would pass even when it regressed.
    const sent: unknown[] = [];
    addBroadcastListener((channel, payload) => {
      if (channel === "fake:status") sent.push(payload);
    });

    const f = new Fake();
    f.shouldFail = true;
    f.start();
    await Promise.resolve(); // one failed connect -> goOffline, already offline
    f.stop(); // stop() -> goOffline again, still offline

    assert.deepEqual(sent, [], "an already-offline integration must broadcast nothing");
  });

  test("a connected integration does broadcast when it drops offline", async () => {
    const sent: unknown[] = [];
    addBroadcastListener((channel, payload) => {
      if (channel === "drop:status") sent.push(payload);
    });

    const f = new Fake("drop:status");
    f.start();
    await Promise.resolve(); // connects -> emits connected
    f.stop(); // -> goOffline emits OFFLINE

    assert.equal(sent.length, 2, "expected a connected snapshot then an offline one");
    assert.deepEqual(sent[1], OFFLINE);
  });
});
