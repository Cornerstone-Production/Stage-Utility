// The polling event transport's buffer and client registry.
//
// Drives the REAL EventPollHub — only its clock is replaced, so the age trim,
// the cap, the resync decision and the sweep are the code that runs in
// production. Nothing here reads source text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventPollHub, POLL_CLIENT_TTL_MS, type PollFrame } from "./event-poll.js";

/** A movable clock, so 60 s of buffer age costs no wall time. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const SNAPSHOT: PollFrame[] = [
  { channel: "server:hello", serialized: '{"version":"1.2.3"}' },
  { channel: "pco:live", serialized: '{"mode":"idle"}' },
  { channel: "spl:metrics", serialized: '{"db":72}' },
];
const snapshot = () => SNAPSHOT.map((f) => ({ ...f }));
const wantsAll = () => true;

/** A hub with one attached client, which is what makes record() do anything. */
function hubWithClient(opts: Partial<Parameters<typeof makeHub>[0]> = {}) {
  const hub = makeHub(opts);
  captureLog(() => hub.hub.touch("c1")); // swallow the "started" line
  return hub;
}

function makeHub(opts: { now?: () => number } = {}) {
  const changes: number[] = [];
  const expired: string[] = [];
  const hub = new EventPollHub({
    now: opts.now,
    subscriptionsChanged: () => changes.push(1),
    onExpire: (cid) => expired.push(cid),
  });
  return { hub, changes, expired };
}

/**
 * Run `fn` with console.log captured, and hand back what it wrote.
 *
 * The hub has no injectable log sink on purpose: log-injection.test.ts rejects
 * handing a pre-built string to console.log, and it is right to — an injected
 * sink is exactly where a scrub goes missing. So the lines are built in place
 * and read back from the console.
 */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.log = real;
  }
  return lines;
}

describe("event-poll buffer", () => {
  it("numbers frames from 1, monotonically", () => {
    const { hub } = hubWithClient();
    hub.record("a", { n: 1 });
    hub.record("b", { n: 2 });
    assert.equal(hub.currentSeq(), 2);
    const r = hub.buildPollResponse("c1", 0, wantsAll, snapshot);
    assert.deepEqual(r.frames.map((f) => f.channel), ["a", "b"]);
    assert.equal(r.seq, 2);
  });

  it("uses the caller's serialized string rather than re-stringifying", () => {
    const { hub } = hubWithClient();
    // The broadcaster hands the fan-out a string it already built; re-serializing
    // the payload would double the cost of the largest channel in the app.
    hub.record("stage:state-changed", { big: true }, '{"already":"serialized"}');
    const r = hub.buildPollResponse("c1", 0, wantsAll, snapshot);
    assert.equal(r.frames[0].serialized, '{"already":"serialized"}');
  });

  it("holds at most 500 frames", () => {
    const { hub } = hubWithClient();
    for (let i = 0; i < 600; i++) hub.record("spl:metrics", { i });
    assert.equal(hub.bufferSize(), 500, "the cap is what stops a stalled client growing server memory");
    // The 500 kept are the NEWEST, so seq 101 is the oldest survivor.
    const r = hub.buildPollResponse("c1", 100, wantsAll, snapshot);
    assert.equal(r.resync, false, "asking from exactly the oldest kept point is still a continuation");
    assert.equal(r.frames.length, 500);
  });

  it("drops frames older than 60 s", () => {
    const c = clock();
    const { hub } = hubWithClient({ now: c.now });
    hub.record("a", { n: 1 });
    c.advance(61_000);
    hub.record("b", { n: 2 });
    assert.equal(hub.bufferSize(), 1, "a minute-old frame is not news to anybody");
    const r = hub.buildPollResponse("c1", 2, wantsAll, snapshot);
    assert.equal(r.frames.length, 0);
  });
});

describe("event-poll response", () => {
  it("answers a client with no position with the snapshot and no resync", () => {
    const { hub } = hubWithClient();
    const r = hub.buildPollResponse("c1", null, wantsAll, snapshot);
    assert.equal(r.resync, false, "a first poll lost nothing, so nothing to resync");
    assert.deepEqual(r.frames.map((f) => f.channel), ["server:hello", "pco:live", "spl:metrics"]);
  });

  it("resyncs a client whose position has rotated out of the buffer", () => {
    const { hub } = hubWithClient();
    for (let i = 0; i < 600; i++) hub.record("spl:metrics", { i });
    // seq 1..100 are gone. A client still at 1 has a hole it cannot fill.
    const r = hub.buildPollResponse("c1", 1, wantsAll, snapshot);
    assert.equal(r.resync, true, "a client handed only the surviving frames would render a state it never saw built");
    assert.deepEqual(r.frames.map((f) => f.channel), ["server:hello", "pco:live", "spl:metrics"]);
  });

  it("resyncs a client that is ahead of us, as after a server restart", () => {
    const { hub } = hubWithClient();
    hub.record("a", {});
    const r = hub.buildPollResponse("c1", 4242, wantsAll, snapshot);
    assert.equal(r.resync, true, "a counter that restarted below the client would starve it forever");
  });

  it("returns only frames newer than the client's position", () => {
    const { hub } = hubWithClient();
    hub.record("a", { n: 1 });
    hub.record("b", { n: 2 });
    hub.record("c", { n: 3 });
    const r = hub.buildPollResponse("c1", 2, wantsAll, snapshot);
    assert.deepEqual(r.frames.map((f) => f.channel), ["c"]);
  });

  it("applies the client's channel filter to both the buffer and the snapshot", () => {
    const { hub } = hubWithClient();
    hub.record("spl:metrics", { db: 1 });
    hub.record("pco:live", { mode: "item" });
    const wants = (c: string) => c !== "spl:metrics";
    assert.deepEqual(
      hub.buildPollResponse("c1", 0, wants, snapshot).frames.map((f) => f.channel),
      ["pco:live"],
      "a filtered channel must not arrive through the buffer",
    );
    assert.deepEqual(
      hub.buildPollResponse("c1", null, wants, snapshot).frames.map((f) => f.channel),
      ["server:hello", "pco:live"],
      "a filtered channel must not arrive through the snapshot either",
    );
  });
});

describe("event-poll client registry", () => {
  it("announces a new client once, and tells the broadcaster", () => {
    const { hub, changes } = makeHub();
    const lines = captureLog(() => {
      hub.buildPollResponse("panel-1", null, wantsAll, snapshot);
      hub.buildPollResponse("panel-1", 0, wantsAll, snapshot);
    });
    assert.equal(changes.length, 1, "a producer gated on subscribers must be started exactly once");
    assert.deepEqual(lines, ["[events] poll client panel-1 started"]);
    hub.stopSweep();
  });

  it("escapes a cid that would otherwise forge a log line", () => {
    // The cid is whatever a caller put on the query string. /log renders one
    // record per line, so a newline in it writes a line the server never wrote.
    const { hub } = makeHub();
    const lines = captureLog(() => {
      hub.buildPollResponse("x\n[stage-controller] plan switched", null, wantsAll, snapshot);
    });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("\n"), `a raw newline reached the log: ${JSON.stringify(lines[0])}`);
    assert.ok(lines[0].includes("x\\n[stage-controller]"), `expected the newline escaped, got: ${lines[0]}`);
    hub.stopSweep();
  });

  it("expires a client that stops polling, and tells the broadcaster", () => {
    const c = clock();
    const { hub, changes, expired } = makeHub({ now: c.now });
    const lines = captureLog(() => {
      hub.buildPollResponse("panel-1", null, wantsAll, snapshot);
      c.advance(POLL_CLIENT_TTL_MS + 1);
      hub.sweep();
    });
    assert.deepEqual(expired, ["panel-1"]);
    assert.equal(changes.length, 2, "a producer must be allowed to stand down when the last poll client goes");
    assert.ok(
      lines.includes("[events] poll client panel-1 expired (no poll for 30s)"),
      `expected an expiry line, got: ${lines.join(" | ")}`,
    );
    assert.deepEqual(hub.clientIds(), []);
  });

  it("keeps a client that is still polling", () => {
    const c = clock();
    const { hub, expired } = makeHub({ now: c.now });
    hub.buildPollResponse("panel-1", null, wantsAll, snapshot);
    c.advance(20_000);
    hub.buildPollResponse("panel-1", 0, wantsAll, snapshot);
    c.advance(20_000);
    hub.sweep();
    assert.deepEqual(expired, [], "40 s of continuous polling must not evict anybody");
    hub.stopSweep();
  });

  it("runs no sweep timer with nobody polling", () => {
    const c = clock();
    const { hub } = makeHub({ now: c.now });
    assert.equal(hub.sweepRunning(), false, "a timer must not exist before the first client");
    hub.buildPollResponse("panel-1", null, wantsAll, snapshot);
    assert.equal(hub.sweepRunning(), true);
    c.advance(POLL_CLIENT_TTL_MS + 1);
    hub.sweep();
    assert.equal(hub.sweepRunning(), false, "an appliance with no poll clients must hold no timer");
  });

  it("records nothing while no poll client is attached", () => {
    // Recording would force a JSON.stringify of every broadcast on an appliance
    // that has no polling client at all — the SSE fan-out deliberately avoids
    // exactly that.
    const { hub } = makeHub();
    hub.record("spl:metrics", { db: 72 });
    assert.equal(hub.bufferSize(), 0);
    assert.equal(hub.currentSeq(), 0);
  });
});
