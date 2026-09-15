// The one rule a Ticker exists to hold: after every tick, armed again unless
// stopped.
//
// It is here because the hand-rolled version of this got it wrong in production.
// SenSource's SafeSpace reading guarded its tick with
//
//     if (!this.running || !id || this.safeSpaceInFlight || this.testing) return;
//
// above the try whose `finally` held the ONLY re-arm in the whole call graph.
// Three of those four conditions mean "nothing to do this tick" and one means
// "stop", and because they were spelled identically the three that meant defer
// silently meant cancel: pressing Test connection left the one-shot timer
// unarmed and the live occupancy dead until the card was saved again.
//
// So every case below is about a tick that did NOT do its work still leaving a
// tick armed behind it. None of them is about the work.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Ticker, type TickOutcome } from "./ticker.js";

/** A ticker whose arm is captured rather than fired — no real timers here. */
function harness(
  opts: {
    tick: () => Promise<TickOutcome>;
    wanted?: () => boolean;
    generation?: () => number;
  },
): { ticker: Ticker; armed: number[] } {
  const armed: number[] = [];
  const ticker = new Ticker({
    tick: opts.tick,
    nextDelayMs: (outcome) => (outcome === "done" ? 10 : outcome === "skip" ? 20 : 30),
    wanted: opts.wanted ?? (() => true),
    generation: opts.generation,
  });
  ticker.arm = (ms: number) => armed.push(ms);
  return { ticker, armed };
}

describe("Ticker", () => {
  it("arms the next tick after a tick that did the work", async () => {
    const { ticker, armed } = harness({ tick: async () => "done" });
    await ticker.run();
    assert.deepEqual(armed, [10]);
  });

  it("arms the next tick after a tick that SKIPPED", async () => {
    // THE GUARD. This is the production failure, reduced: a body that declines
    // to do the work this time must leave the poller running. With the re-arm
    // back inside the body's own success path this is `[]`, and the reading is
    // dead for good.
    const { ticker, armed } = harness({ tick: async () => "skip" });
    await ticker.run();
    assert.deepEqual(armed, [20], "a skipped tick cancelled the poller instead of deferring it");
  });

  it("arms the next tick after a tick that THREW, then lets the throw out", async () => {
    // A log line, a broadcast listener or an emit can throw from inside a tick.
    // The old shape survived that with a try/finally; this has to as well, and
    // the rejection still has to reach the caller — server.ts writes it to /log.
    const { ticker, armed } = harness({
      tick: async () => {
        throw new Error("a broadcast listener threw");
      },
    });
    await assert.rejects(() => ticker.run(), /a broadcast listener threw/);
    assert.deepEqual(armed, [30], "a tick that threw left the poller unarmed");
  });

  it("does not arm while the owner does not want it", async () => {
    // "Stopped" is a property of the OWNER, asked on every arm — not something a
    // tick body has to remember to return.
    const { ticker, armed } = harness({ tick: async () => "done", wanted: () => false });
    ticker.arm = Ticker.prototype.arm.bind(ticker);
    ticker.arm(5);
    assert.equal(ticker.armed, false, "a stopped ticker armed a timer");
    void armed;
  });

  it("does not arm behind a reconfigure that landed mid-tick", async () => {
    // Whoever moved the generation has already armed a timer of its own; arming
    // here would replace it with one scoped to a configuration nobody runs.
    let generation = 1;
    const { ticker, armed } = harness({
      tick: async () => {
        generation++;
        return "done";
      },
      generation: () => generation,
    });
    await ticker.run();
    assert.deepEqual(armed, [], "a superseded tick re-armed over the new configuration's timer");
  });

  it("arms after a tick whose generation did NOT move", async () => {
    // The other half of the case above — the supersession check must not be a
    // blanket refusal to re-arm.
    const generation = 1;
    const { ticker, armed } = harness({ tick: async () => "done", generation: () => generation });
    await ticker.run();
    assert.deepEqual(armed, [10]);
  });

  it("run() clears the pending tick, so `armed` is honest while one is running", async () => {
    const ticker = new Ticker({
      tick: async () => {
        assert.equal(ticker.armed, false, "a running tick still counted as pending");
        return "done";
      },
      nextDelayMs: () => 60_000,
      wanted: () => true,
    });
    ticker.arm(60_000);
    assert.equal(ticker.armed, true);
    await ticker.run();
    assert.equal(ticker.armed, true, "the next tick was not armed");
    ticker.cancel();
    assert.equal(ticker.armed, false, "cancel() left a timer behind");
  });
});
