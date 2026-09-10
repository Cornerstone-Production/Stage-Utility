// The `cues` live channel.
//
// What is guarded, and each is a real cost rather than a nicety:
//
//  - NOBODY SUBSCRIBED MEANS NO TIMER AND NO READS. This is the only reason
//    the timer exists, so a producer that ran it anyway and skipped the work
//    inside — which is how every other channel in this app is gated — would ask
//    Companion for every bound variable every five seconds for the rest of the
//    week on an install with no integration. The read stub being called ZERO
//    times is the assertion; a stub that was called and discarded would pass a
//    weaker test just as happily.
//  - ONLY CHANGES GO OUT. A projector on since Thursday is not an event.
//  - THE LAST SUBSCRIBER LEAVING STOPS IT, and says so in the log — an operator
//    reading /log has to be able to tell a channel that stopped from one that
//    never started.
//
// The timer is INJECTED rather than mocked at the runtime: node:test's
// mock.timers does not drive an unref'd interval predictably, and what has to
// be asserted is the interval Companion is asked at, which is a number this can
// read straight off the call.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

// cue-live reaches cue-manifest, which reaches stage-controller, which resolves
// the data directory at import.
process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "cue-live-"));

const { cueLive, cueLiveDeps, CUES_POLL_MS } = await import("./cue-live.js");
type CuesEvent = import("./cue-live.js").CuesEvent;

type Row = { state: "on" | "off" | "unknown"; reason?: string };

let STATES: Record<string, Row> = {};
let reads = 0;
let subscribed = false;
let events: CuesEvent[] = [];
let lines: string[] = [];
/** The interval callback the producer registered, and how often it asked. */
let tick: (() => void) | null = null;
let everyMs = 0;
let cleared = 0;

const realLog = console.log;

beforeEach(() => {
  STATES = {};
  reads = 0;
  subscribed = false;
  events = [];
  lines = [];
  tick = null;
  everyMs = 0;
  cleared = 0;
  cueLiveDeps.watched = () => subscribed;
  cueLiveDeps.subscribers = () => (subscribed ? 2 : 0);
  cueLiveDeps.read = async () => {
    reads++;
    return { states: STATES };
  };
  cueLiveDeps.setInterval = (fn, ms) => {
    tick = fn;
    everyMs = ms;
    return { unref: () => undefined } as unknown as NodeJS.Timeout;
  };
  cueLiveDeps.clearInterval = () => {
    cleared++;
    tick = null;
  };
  cueLiveDeps.emit = (e) => events.push(e);
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
});

/** Let the producer's async tick settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

/** Run one scheduled poll and let it finish. */
const poll = async () => {
  tick?.();
  await settle();
};

const stopEverything = async () => {
  subscribed = false;
  cueLive.subscriptionsChanged();
  await settle();
  console.log = realLog;
};

describe("nobody is subscribed", () => {
  test("nothing is scheduled and Companion is never read", async () => {
    cueLive.subscriptionsChanged();
    await settle();
    assert.equal(String(reads), "0");
    assert.equal(String(tick === null), "true");
    assert.deepEqual(events, []);
    console.log = realLog;
  });
});

describe("somebody subscribes", () => {
  test("it polls every five seconds and says so once", async () => {
    STATES = { projectors: { state: "off" } };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();

    // The first read is IMMEDIATE — a client that just subscribed is looking at
    // nothing until one lands.
    assert.equal(String(reads), "1");
    assert.equal(String(everyMs), String(CUES_POLL_MS));
    assert.deepEqual(
      lines.filter((l) => l.includes("live channel")),
      ["[cues] live channel: polling every 5 s for 2 subscriber(s)"],
    );

    // A second client subscribing does not start a second timer, or restate it.
    cueLive.subscriptionsChanged();
    await settle();
    assert.equal(
      lines.filter((l) => l.includes("live channel: polling every")).length,
      1,
      "a second subscriber started a second poll",
    );

    await poll();
    assert.equal(String(reads), "2");
    await stopEverything();
  });

  test("only a CHANGE is broadcast", async () => {
    STATES = { projectors: { state: "off" } };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    assert.deepEqual(events, [{ type: "state", id: "projectors", state: "off" }]);

    // Unchanged: nothing goes out, however many times it is read.
    await poll();
    await poll();
    assert.equal(String(events.length), "1");

    STATES = { projectors: { state: "on" } };
    await poll();
    assert.deepEqual(events.slice(1), [{ type: "state", id: "projectors", state: "on" }]);

    // The REASON is part of the comparison: still unknown, different why.
    STATES = { projectors: { state: "unknown", reason: "no such custom variable in Companion" } };
    await poll();
    STATES = { projectors: { state: "unknown", reason: 'value "WARMUP" matches neither' } };
    await poll();
    assert.deepEqual(
      events.slice(2).map((e) => ("reason" in e ? String(e.reason) : "")),
      ["no such custom variable in Companion", 'value "WARMUP" matches neither'],
    );
    await stopEverything();
  });

  test("the last one leaving stops the poll, and says so", async () => {
    STATES = { projectors: { state: "off" } };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    const before = reads;

    subscribed = false;
    cueLive.subscriptionsChanged();
    await settle();

    assert.equal(String(cleared), "1");
    assert.equal(String(tick === null), "true");
    assert.equal(String(reads), String(before), "a stopped channel read Companion");
    assert.deepEqual(
      lines.filter((l) => l.includes("polling stopped")),
      ["[cues] live channel: polling stopped"],
    );

    // Idempotent: a second disconnect is not a second line.
    cueLive.subscriptionsChanged();
    await settle();
    assert.equal(lines.filter((l) => l.includes("polling stopped")).length, 1);
    console.log = realLog;
  });
});

describe("the rules change", () => {
  test("a manifest event goes out with the new version", async () => {
    cueLive.rulesChanged();
    const first = events.at(-1);
    assert.equal(first?.type, "manifest");
    const v1 = first && "version" in first ? first.version : 0;

    cueLive.rulesChanged();
    const second = events.at(-1);
    const v2 = second && "version" in second ? second.version : 0;
    assert.equal(String(v2 > v1), "true");
    console.log = realLog;
  });

  test("the state comparison is forgotten, so the next poll re-states everything", async () => {
    // A binding edited, or a pair deleted and remade, is a different question
    // than the one the last answer answered.
    STATES = { projectors: { state: "on" } };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    assert.equal(String(events.length), "1");

    await poll();
    assert.equal(String(events.length), "1", "an unchanged state was re-broadcast");

    cueLive.rulesChanged();
    await poll();
    assert.deepEqual(events.at(-1), { type: "state", id: "projectors", state: "on" });
    await stopEverything();
  });
});

describe("a read that fails", () => {
  test("is logged and the poll carries on", async () => {
    // cueStates.read is documented as never throwing; this is the case where
    // that contract broke. Rethrowing out of a timer callback would take the
    // process down for one unreadable variable.
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      subscribed = true;
      cueLiveDeps.read = async () => {
        reads++;
        throw new Error("secrets.bin is unreadable");
      };
      cueLive.subscriptionsChanged();
      await settle();
      assert.deepEqual(errors, ["[cues] live channel read failed: secrets.bin is unreadable"]);

      // And the next poll still runs.
      await poll();
      assert.equal(String(reads), "2");
    } finally {
      console.error = realError;
      await stopEverything();
    }
  });
});
