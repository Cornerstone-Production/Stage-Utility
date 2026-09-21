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
  SERVER_CLOCK_MAX_BACKWARD_MS,
  SERVER_CLOCK_SLEW_MS,
  SERVER_CLOCK_STALE_MS,
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

  /** Deliver a pair whose two legs are UNEQUAL. The stamp is honest; what the
   *  client cannot see is that the round trip it measured was lopsided, which is
   *  the whole source of a paired sample's residual error. */
  deliverPairedAsymmetric(outMs: number, backMs: number): void {
    this.advance(outMs);
    const stamped = this.serverMs;
    this.advance(backMs);
    this.clock.observe(stamped, outMs + backMs);
  }

  /** Two prompt unpaired frames a second and a half apart — the least a clock
   *  that has never been set will take. See SERVER_CLOCK_MIN_SPREAD_MS. */
  syncUnpaired(): void {
    this.deliver(0);
    this.advance(1500);
    this.deliver(0);
  }

  /** How far the clock's answer is from true server time. */
  errorMs(): number {
    return this.clock.now() - this.serverMs;
  }

  /**
   * Read the clock once a second for `seconds`, and return the worst change
   * between consecutive readings. Negative means the digits on the wall went
   * backwards.
   */
  worstTickMs(seconds: number): number {
    let worst = Number.POSITIVE_INFINITY;
    let last = this.clock.now();
    for (let i = 0; i < seconds; i++) {
      this.advance(1000);
      const next = this.clock.now();
      worst = Math.min(worst, next - last);
      last = next;
    }
    return worst;
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
    w.syncUnpaired(); // prompt frames, so the clock is on true time
    // Long enough that those have fallen out of the window, then only delayed
    // ones. The clock follows them down rather than holding the old maximum.
    w.advance(SERVER_CLOCK_WINDOW_MS + 1000);
    for (let i = 0; i < 3; i++) {
      w.deliver(600);
      w.advance(1000);
    }
    // Bounded on BOTH sides: `<= -400` alone passes for a clock that dropped by
    // any amount at all, including one that threw the window away entirely.
    assert.ok(
      w.errorMs() <= -400 && w.errorMs() >= -800,
      `a maximum older than the ${SERVER_CLOCK_WINDOW_MS}ms window must be dropped and the clock must ` +
        `settle on the 600ms-delayed ones; it is off by ${w.errorMs()}ms`,
    );
  });

  test("a stalled request does not latch the clock fast", () => {
    // THE regression this pool split exists for. A paired sample's residual is
    // two-signed at ±rtt/2 on an asymmetric round trip, so selecting the biggest
    // offset picks the most positively biased outlier and then holds it for the
    // whole window. One stalled poll — 4 s out, answered instantly — used to set
    // the clock ~2 s fast and keep it there while every healthy poll was ignored.
    const w = new World();
    w.deliverPaired(20);
    w.deliverPairedAsymmetric(4000, 0);
    for (let i = 0; i < 10; i++) {
      w.advance(2000);
      w.deliverPaired(20);
    }
    assert.ok(
      Math.abs(w.errorMs()) <= 20,
      `ten healthy polls after one stalled request, the clock is still ${w.errorMs()}ms out — ` +
        `the stalled sample was latched instead of being rejected on its round trip`,
    );
  });

  test("with a steady round trip the newest paired sample is the one used", () => {
    // The tie-break, and it is not decoration: every sample ties on rtt in the
    // ordinary case, and a delay-corrected reading should follow the newest.
    const w = new World();
    w.deliverPaired(20);
    w.advance(2000);
    w.serverMs += 400; // the server's clock nudged forward between polls
    w.deliverPaired(20);
    w.advance(SERVER_CLOCK_SLEW_MS + 10); // 400ms is under the step, so it eases
    assert.ok(
      Math.abs(w.errorMs()) <= 20,
      `the clock ignored a newer sample with the same round trip; it is ${w.errorMs()}ms out`,
    );
  });

  test("a NaN stamp is refused rather than poisoning the clock", () => {
    const w = new World();
    assert.equal(w.clock.observe(Number.NaN), "ignored");
    assert.equal(w.clock.synced(), false);
  });
});

describe("ServerClock — a replayed frame is not a reading", () => {
  test("a hello burst cannot sync a clock that has never been set", () => {
    // The SSE hello burst hands a fresh connection every hydrated channel at
    // once, each carrying whatever it was last broadcast with — `pco:live` can be
    // five minutes old outside a service window, and it is NOT flagged as a
    // replay on the wire. Several such frames arrive in the same tick, so
    // "several samples" is no protection; "several samples spread over time" is.
    const w = new World();
    const stale = w.serverMs - 5 * 60_000;
    assert.equal(w.clock.observe(stale), "waiting");
    assert.equal(w.clock.observe(stale + 900), "waiting", "a second frame from the same burst is not corroboration");
    assert.equal(
      w.clock.synced(),
      false,
      `the clock adopted a hello-burst frame; it now reads ${w.errorMs()}ms out and blames the browser for it`,
    );
    assert.deepEqual(w.logs, [], "and it must not say the operator's clock is five minutes slow on the strength of it");
  });

  test("the next real frame after the burst is what sets it", () => {
    const w = new World();
    w.clock.observe(w.serverMs - 5 * 60_000); // the burst
    w.advance(15_000); // the keepalive, one LIVE_KEEPALIVE_MS later
    w.deliver(0);
    assert.equal(w.clock.synced(), true, "a frame a keepalive after the burst is a real reading and must be taken");
    assert.ok(Math.abs(w.errorMs()) <= 20, `the clock should be on the server's time, it is ${w.errorMs()}ms out`);
  });

  test("one round-trip-measured sample syncs on its own, immediately", () => {
    // It carries its own delay measurement, so there is nothing to corroborate —
    // and a polling panel must not spend a keepalive on its own host clock.
    const w = new World();
    w.deliverPaired(40);
    assert.equal(w.clock.synced(), true);
    assert.ok(Math.abs(w.errorMs()) <= 5);
  });

  test("a replayed frame arriving after sync is refused, not pooled", () => {
    // The warm case: a component mounting mid-session is handed the client's own
    // replay cache, whose `serverNow` says when the frame was FIRST seen.
    const w = new World();
    w.syncUnpaired();
    const before = w.errorMs();
    assert.equal(w.clock.observe(w.serverMs - 5 * 60_000), "stale");
    assert.ok(
      Math.abs(w.errorMs() - before) <= 5,
      `a five-minute-old replay moved the clock by ${w.errorMs() - before}ms`,
    );
  });

  test("but refusing is suspended rather than locking the clock out", () => {
    // A freshness test with no escape is a lock-out: a clock that had latched
    // high would refuse every sample that disagreed with it and never come down.
    // Once the window has emptied, the next sample is the only evidence there is
    // and must be taken — the backward clamp is what stops it being believed all
    // at once.
    const w = new World();
    w.syncUnpaired();
    w.advance(SERVER_CLOCK_WINDOW_MS + 1000);
    assert.notEqual(
      w.clock.observe(w.serverMs - 3 * SERVER_CLOCK_STALE_MS),
      "stale",
      "the clock refused the only sample left and can now never be corrected",
    );
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
    w.syncUnpaired();
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

  test("a batched stream released a minute late does not tick the display backwards", () => {
    // The default Ultritouch. Not on `?transport=poll`, so DashBoard's fallback
    // browser holds the event stream and releases a minute of frames at once. A
    // frame released 62 s late used to move the display back 62 s between two
    // one-second frames — a stage clock counting up for a minute and then jumping
    // back a minute.
    const w = new World();
    w.syncUnpaired();
    w.advance(SERVER_CLOCK_WINDOW_MS + 2000); // the window empties while the browser buffers
    w.deliver(62_000);
    const worst = w.worstTickMs(10);
    assert.ok(
      worst >= 0,
      `THE DISPLAY TICKED BACKWARD ${worst}ms between two one-second frames; a stage clock may pause, never reverse`,
    );
  });

  test("a backward correction is clamped, and says so once", () => {
    const w = new World();
    w.syncUnpaired();
    w.advance(SERVER_CLOCK_WINDOW_MS + 2000);
    const before = w.errorMs();
    w.deliver(62_000);
    w.advance(SERVER_CLOCK_SLEW_MS + 10);
    const moved = w.errorMs() - before;
    assert.ok(
      moved >= -SERVER_CLOCK_MAX_BACKWARD_MS - 5,
      `one correction moved the clock back ${-moved}ms; the clamp is ${SERVER_CLOCK_MAX_BACKWARD_MS}ms`,
    );
    const clamped = w.logs.filter((l) => /holding the clock back/.test(l));
    assert.equal(clamped.length, 1, `expected one line about the clamp, got ${JSON.stringify(w.logs)}`);
    // And a second clamped correction in the same episode adds nothing: a
    // display left against a stream a minute behind would otherwise write a line
    // per frame for as long as it lasted.
    w.advance(1000);
    w.deliver(62_000);
    assert.equal(w.logs.filter((l) => /holding the clock back/.test(l)).length, 1);
  });

  test("a genuine backward server clock is followed, a clamp at a time", () => {
    // The cost of the clamp, stated: a server whose clock really moved back is
    // converged on rather than jumped to. Refusing to converge at all was the
    // alternative and would leave a display permanently fast.
    //
    // It takes the WINDOW plus one clamp per second of change: the pre-change
    // samples are still the maximum until they age out, which is the same
    // property that makes a single late frame harmless.
    const w = new World();
    w.syncUnpaired();
    w.serverMs -= 4000; // somebody set the server's clock back four seconds
    for (let i = 0; i < 30; i++) {
      w.advance(2000);
      w.deliver(0);
    }
    assert.ok(
      Math.abs(w.errorMs()) <= 50,
      `the clock never converged on the server's new time; it is ${w.errorMs()}ms out`,
    );
  });

  test("a host clock that is hours out says so on the first sample", () => {
    const w = new World();
    w.hostErrorMs = 7 * 3_600_000 + 2 * 60_000;
    w.deliverPaired(0);
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /7h 2m fast/);
  });
});
