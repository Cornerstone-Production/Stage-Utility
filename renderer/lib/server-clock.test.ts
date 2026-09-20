// Guards on the three things server-clock.ts exists to get right. Each drives
// the REAL ServerClock class with an injected pair of clocks rather than reading
// its source or sleeping — the delay, the host clock and the elapsed time are all
// things a test has to be able to set, and none of them can be set on the host.
//
// The model below is the whole point: `serverMs` is TRUE server time, `monoMs` is
// this browser's monotonic counter (which advances with it), and `hostErrorMs` is
// how wrong the browser's WALL clock is — the panel this was written for is seven
// hours fast and gaining two more a day. A frame is delivered by stamping the
// server's time, advancing the world by the delivery delay, and only then handing
// the stamp over, which is exactly what the wire does.
//
// What is NOT guarded here: that the rendered digits move. jsdom lays out
// nothing, so a clock's appearance is a browser job — see the note in
// server-clock-hooks.test.tsx.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  SERVER_CLOCK_SLEW_MS,
  SERVER_CLOCK_STEP_MS,
  SERVER_CLOCK_WINDOW_MS,
  ServerClock,
} from "./server-clock.js";

/** A world with three independent clocks, all of which a case can move. */
class World {
  /** TRUE server time, epoch ms. */
  serverMs = Date.UTC(2026, 8, 20, 15, 0, 0);
  /** This browser's monotonic counter. Advances with true time, never steps. */
  monoMs = 12_345;
  /** How far the browser's WALL clock is ahead of true time. */
  hostErrorMs = 0;
  readonly logs: string[] = [];

  readonly clock = new ServerClock({
    wall: () => this.serverMs + this.hostErrorMs,
    mono: () => this.monoMs,
    log: (m) => this.logs.push(m),
  });

  /** Time passes: true time and the monotonic counter move together. */
  advance(ms: number): void {
    this.serverMs += ms;
    this.monoMs += ms;
  }

  /** Deliver a pushed frame stamped NOW and received `delayMs` later. */
  deliver(delayMs: number): void {
    const stamped = this.serverMs;
    this.advance(delayMs);
    this.clock.observe(stamped);
  }

  /** Deliver a request/response pair: the client asks, the server stamps half a
   *  round trip later, the answer arrives half a round trip after that. */
  deliverPaired(rttMs: number): void {
    this.advance(rttMs / 2);
    const stamped = this.serverMs;
    this.advance(rttMs / 2);
    this.clock.observe(stamped, rttMs);
  }

  /** How far the clock's answer is from true server time. */
  errorMs(): number {
    return this.clock.now() - this.serverMs;
  }
}

describe("ServerClock — delivery delay", () => {
  test("a measured round trip is added back, so the clock does not lag by it", () => {
    const w = new World();
    // A 2 s round trip is the polling transport's worst case: the frame sat in
    // the server's buffer for the interval before the client fetched it.
    for (let i = 0; i < 5; i++) {
      w.deliverPaired(2000);
      w.advance(2000);
    }
    assert.ok(
      Math.abs(w.errorMs()) <= 5,
      `a round-trip-corrected clock must track true server time; it is off by ${w.errorMs()}ms ` +
        `(uncorrected it would sit ~1000ms behind, half the round trip)`,
    );
  });

  test("with no pairing, the LEAST delayed recent sample wins, not the newest", () => {
    const w = new World();
    // A burst of badly delayed frames with one prompt one in the middle, then a
    // slow one last. Taking the newest leaves the clock 1.9 s behind; taking the
    // best of the window leaves it 40 ms behind.
    for (const delay of [2000, 1500, 40, 1900]) {
      w.deliver(delay);
      w.advance(500);
    }
    assert.ok(
      Math.abs(w.errorMs()) <= 100,
      `the best of the window is the least-delayed sample (40ms); the clock is off by ` +
        `${w.errorMs()}ms, which is what trusting the NEWEST sample (1900ms late) looks like`,
    );
  });

  test("a sample older than the window stops being the best answer", () => {
    const w = new World();
    w.deliver(10); // a good one
    // Long enough that the good sample has fallen out of the window, then only
    // delayed ones. The clock follows them rather than holding the old maximum.
    w.advance(SERVER_CLOCK_WINDOW_MS + 1000);
    for (let i = 0; i < 3; i++) {
      w.deliver(600);
      w.advance(1000);
    }
    assert.ok(
      w.errorMs() <= -400,
      `a maximum older than the ${SERVER_CLOCK_WINDOW_MS}ms window must be dropped; ` +
        `the clock is off by ${w.errorMs()}ms, i.e. still holding it`,
    );
  });

  test("a NaN stamp is refused rather than poisoning the clock", () => {
    const w = new World();
    assert.equal(w.clock.observe(Number.NaN), "ignored");
    assert.equal(w.clock.synced(), false);
  });
});

describe("ServerClock — the host clock cannot move it", () => {
  test("a host clock that runs fast does not move the display", () => {
    const w = new World();
    w.deliverPaired(20);
    const before = w.errorMs();
    // Two hours a day, the rate measured on the Ultritouch panel, over a minute
    // with no frames at all.
    for (let i = 0; i < 60; i++) {
      w.advance(1000);
      w.hostErrorMs += 83;
    }
    assert.ok(
      Math.abs(w.errorMs() - before) <= 2,
      `the clock must advance off the monotonic source only; a host clock gaining ` +
        `2h/day moved it by ${(w.errorMs() - before).toFixed(0)}ms over 60s`,
    );
  });

  test("a host clock that STEPS does not move the display", () => {
    const w = new World();
    w.deliverPaired(20);
    const before = w.errorMs();
    w.advance(5000);
    w.hostErrorMs += 7 * 3_600_000; // someone set the panel's clock seven hours out
    assert.ok(
      Math.abs(w.errorMs() - before) <= 2,
      `a seven-hour host clock step moved the display by ${w.errorMs() - before}ms; it must move it by 0`,
    );
  });

  test("before the first sample the host clock is all there is", () => {
    const w = new World();
    w.hostErrorMs = 90_000;
    assert.equal(w.clock.synced(), false);
    assert.equal(w.clock.now(), w.serverMs + 90_000);
  });
});

describe("ServerClock — slew and step", () => {
  test("a small correction is eased in rather than jumping", () => {
    const w = new World();
    w.deliverPaired(0);
    const at = w.clock.now();
    // 300ms of disagreement — under the step threshold.
    w.serverMs += 300;
    w.clock.observe(w.serverMs, 0);
    assert.ok(
      Math.abs(w.clock.now() - at) <= 5,
      `a ${SERVER_CLOCK_STEP_MS}ms-or-smaller correction must not land at once; ` +
        `the clock jumped ${w.clock.now() - at}ms on the frame it arrived`,
    );
    w.advance(SERVER_CLOCK_SLEW_MS / 2);
    const half = w.errorMs();
    assert.ok(Math.abs(half + 150) <= 20, `halfway through the ease the clock should be ~150ms short, it is ${half}ms`);
    w.advance(SERVER_CLOCK_SLEW_MS / 2 + 10);
    assert.ok(Math.abs(w.errorMs()) <= 5, `the ease must finish inside ${SERVER_CLOCK_SLEW_MS}ms; left ${w.errorMs()}ms`);
  });

  test("an eased correction backwards never runs the clock backwards", () => {
    const w = new World();
    // The one way the estimate can fall: a prompt sample ages out of the window
    // and the best that is left is a delayed one. 999ms is the largest such drop
    // that still eases, and at that size the displayed clock must PAUSE rather
    // than ever tick backwards.
    w.deliver(0);
    w.advance(SERVER_CLOCK_WINDOW_MS + 1000);
    w.deliver(SERVER_CLOCK_STEP_MS - 1);
    let last = w.clock.now();
    for (let i = 0; i < 20; i++) {
      w.advance(SERVER_CLOCK_SLEW_MS / 10);
      const next = w.clock.now();
      assert.ok(next >= last, `the clock ticked backwards during an eased correction: ${last} then ${next}`);
      last = next;
    }
    assert.ok(
      Math.abs(w.errorMs() + (SERVER_CLOCK_STEP_MS - 1)) <= 5,
      `the ease must still finish at the new estimate; left ${w.errorMs()}ms`,
    );
  });

  test("a large correction lands at once", () => {
    const w = new World();
    w.deliverPaired(0);
    // A server whose own clock was set, or a machine back from sleep.
    w.serverMs += 45_000;
    w.clock.observe(w.serverMs, 0);
    assert.ok(
      Math.abs(w.errorMs()) <= 5,
      `a correction of ${SERVER_CLOCK_STEP_MS}ms or more must apply immediately, not ease; ` +
        `the clock is still ${w.errorMs()}ms out on the frame it arrived`,
    );
  });

  test("a step says so once and an eased correction says nothing", () => {
    const w = new World();
    w.deliverPaired(0); // first sync, host clock is fine — nothing to say
    assert.deepEqual(w.logs, []);
    w.serverMs += 200;
    w.clock.observe(w.serverMs, 0);
    assert.deepEqual(w.logs, [], "a routine eased correction must not write a line");
    w.serverMs += 30_000;
    w.clock.observe(w.serverMs, 0);
    assert.equal(w.logs.length, 1, `a step is worth one line, got ${JSON.stringify(w.logs)}`);
    assert.match(w.logs[0], /stepped/);
  });

  test("a host clock that is hours out says so on the first sample", () => {
    const w = new World();
    w.hostErrorMs = 7 * 3_600_000 + 2 * 60_000;
    w.deliverPaired(0);
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /7h 2m fast/);
  });
});
