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
const { cueStates } = await import("./cue-states.js");
type CuesEvent = import("./cue-live.js").CuesEvent;

/**
 * The PRODUCTION `read` dep, captured before beforeEach replaces it.
 *
 * Every case below stubs `cueLiveDeps.read` wholesale, which means the real
 * body — the two lines that make the poll the cache refresh — was never
 * executed anywhere in this suite. Deleting `cueStates.invalidate()` from it
 * left the whole project green. One case puts it back; see "the poll IS the
 * cache refresh".
 */
const realRead = cueLiveDeps.read;

type Row = {
  state: "on" | "off" | "unknown";
  reason?: string;
  settling?: true;
  commanded?: "on" | "off";
  hiddenFromHome?: true;
};

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
    // The producer's contract is a MAP — the key is a pair's base out of the
    // rules file, and every reader of it looks a key up dynamically. The record
    // above is only this file's shorthand for writing one; `Object.entries`
    // yields own enumerable keys only, so a base of `constructor` arrives as a
    // real entry and not as something off Object.prototype.
    return { states: new Map(Object.entries(STATES)) };
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

// ── A pair hidden from Home Assistant ────────────────────────────────────────
//
// The manifest omits a hidden pair entirely — `/api/cues/manifest` says it does
// not exist — and this channel has no audience but the integration reading that
// manifest. Pushing a `state` event for it is the server telling an integration
// about an entity it has just been told not to create.
//
// `/api/cues/states` keeps the row on purpose: the app's own rules page reads
// that route for the state pill on every pair, hidden or not, and the generated
// Home Assistant sensor lifts only the bases the YAML put in its
// `json_attributes` list. The split is what CueStateRow.hiddenFromHome is for.
describe("a pair hidden from Home Assistant", () => {
  test("is not pushed, while the pair beside it is", async () => {
    STATES = {
      projectors: { state: "on" },
      voice_only: { state: "off", hiddenFromHome: true },
    };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    assert.deepEqual(events, [{ type: "state", id: "projectors", state: "on" }]);
    await stopEverything();
  });

  test("hidden and shown again re-states it, rather than comparing against what nobody was sent", async () => {
    // Shown, then hidden, then shown again, with the state never changing. The
    // prune has to read the PUSHED set: compared against the whole answer the
    // key is still there while the pair is hidden, so it stays in `last` — and
    // unhiding pushes nothing until the device itself moves. The entity Home
    // Assistant has just created then reads unknown until somebody walks over
    // and turns it off at the wall.
    //
    // `rulesChanged` also clears `last`, and in production a hide IS a rule
    // change — so this drives the poll alone, which is the path that must not
    // depend on that.
    STATES = { voice_only: { state: "on" } };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    assert.deepEqual(events, [{ type: "state", id: "voice_only", state: "on" }]);

    STATES = { voice_only: { state: "on", hiddenFromHome: true } };
    await poll();
    assert.equal(String(events.length), "1", "a hidden pair was pushed");

    STATES = { voice_only: { state: "on" } };
    await poll();
    assert.deepEqual(events, [
      { type: "state", id: "voice_only", state: "on" },
      { type: "state", id: "voice_only", state: "on" },
    ]);
    await stopEverything();
  });
});

// ── A pair that goes away and comes back ─────────────────────────────────────
//
// Only CHANGES go out, so the producer keeps the last state it pushed per pair.
// A pair that has gone away has to be forgotten, or re-adding it later pushes
// nothing until its state changes — and an integration sits on `unknown` until
// somebody walks over and turns the device off at the wall.
//
// The prune was `if (!(id in answer.states))`, and `in` walks the PROTOTYPE
// CHAIN. Of every key on Object.prototype exactly one is a legal cue name under
// CUE_NAME_RE — `constructor` — so `constructor_on`/`constructor_off` is a pair
// the engine accepts today, and `"constructor" in {}` is true while
// `Object.hasOwn` is false. That one base was never pruned.
describe("a pair that goes away and comes back", () => {
  const cycle = async (base: string) => {
    STATES = { [base]: { state: "on" } };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    // Gone.
    STATES = {};
    await poll();
    // Back, in the same state it left in.
    STATES = { [base]: { state: "on" } };
    await poll();
  };

  test("an ordinary base is re-stated", async () => {
    await cycle("projectors");
    assert.deepEqual(events, [
      { type: "state", id: "projectors", state: "on" },
      { type: "state", id: "projectors", state: "on" },
    ]);
    await stopEverything();
  });

  test("and so is `constructor`, which the prototype chain used to keep alive", async () => {
    await cycle("constructor");
    assert.deepEqual(
      events,
      [
        { type: "state", id: "constructor", state: "on" },
        { type: "state", id: "constructor", state: "on" },
      ],
      "the re-created pair was never re-stated: its key survived the prune",
    );
    await stopEverything();
  });
});

// ── The two properties of the producer nothing reached ──────────────────────

describe("the poll IS the cache refresh", () => {
  // `GET /api/cues/states` and the rules page share cue-states' five-second
  // cache. If this channel read AROUND it, a subscribed install would do two
  // rounds of Companion reads every five seconds instead of one — and the
  // route's answer would still be up to five seconds behind what the channel
  // had just pushed.
  //
  // Invisible until now because every case in this file replaces
  // `cueLiveDeps.read` in beforeEach, so the dep's real body never ran. This
  // one uses it, with cue-states itself stubbed.
  test("it drops the cached answer BEFORE it reads, not after and not never", async () => {
    const order: string[] = [];
    const realInvalidate = cueStates.invalidate.bind(cueStates);
    const realCueRead = cueStates.read.bind(cueStates);
    cueStates.invalidate = () => void order.push("invalidate");
    cueStates.read = async () => {
      order.push("read");
      return { ok: true, checkedAt: "2026-09-09T14:00:00.000Z", states: new Map() };
    };
    cueLiveDeps.read = realRead;
    try {
      subscribed = true;
      cueLive.subscriptionsChanged();
      await settle();
      assert.deepEqual(order, ["invalidate", "read"]);

      // And on EVERY tick, not only the first.
      await poll();
      assert.deepEqual(order, ["invalidate", "read", "invalidate", "read"]);
    } finally {
      cueStates.invalidate = realInvalidate;
      cueStates.read = realCueRead;
      await stopEverything();
    }
  });
});

describe("one read at a time", () => {
  // A Companion that takes longer than five seconds to answer must not have a
  // second round of reads stacked on top of the first, and a third on top of
  // that. The reads are per bound variable, so the stack grows by the whole set
  // each tick against the box that is already struggling.
  test("a tick that lands mid-read is dropped, and the next one reads again", async () => {
    // One resolver per read in flight. A `let` holding the latest one narrows
    // to `never` in the type checker, which is a compile error rather than a
    // test — an array says the same thing and reads as what it is.
    const inFlight: (() => void)[] = [];
    cueLiveDeps.read = async () => {
      reads++;
      await new Promise<void>((resolve) => inFlight.push(resolve));
      return { states: new Map() };
    };

    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    assert.equal(String(reads), "1", "the immediate first read");

    // Two five-second ticks while the first read is still in flight.
    tick?.();
    tick?.();
    await settle();
    assert.equal(String(reads), "1", "a slow Companion had its ticks stacked");

    assert.equal(String(inFlight.length), "1", "a second read was started under the first");

    // It finally answers, and the next tick reads for real.
    inFlight.shift()?.();
    await settle();
    await poll();
    assert.equal(String(reads), "2");
    inFlight.shift()?.();
    await settle();
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

// ── A pair settling from a press ──────────────────────────────────────────────
//
// Companion polls the device on its own interval, so for a second or two after
// a press the reading is from before it. cue-states says so on the row
// (`settling`, `commanded`) and tells this channel the moment the real value
// lands. Both halves matter here: pushing a reading known to be stale is what
// made Home Assistant flip a switch back and invite another tap, and waiting
// for the next five-second tick is how long that lasted.
describe("a pair settling from a press", () => {
  test("the commanded state goes out, and so does the window closing", async () => {
    STATES = { projectors: { state: "off", settling: true, commanded: "on" } };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    assert.deepEqual(events, [
      { type: "state", id: "projectors", state: "off", settling: true, commanded: "on" },
    ]);

    // The window closed with the device never having reported the press. The
    // state has not changed, but what an integration should DO with it has: a
    // subscriber never told the window closed goes on showing the command.
    STATES = { projectors: { state: "off" } };
    await poll();
    assert.deepEqual(events, [
      { type: "state", id: "projectors", state: "off", settling: true, commanded: "on" },
      { type: "state", id: "projectors", state: "off" },
    ]);
    await stopEverything();
  });

  test("a value that lands is pushed at once, not at the next five second tick", async () => {
    STATES = { projectors: { state: "off", settling: true, commanded: "on" } };
    subscribed = true;
    cueLive.subscriptionsChanged();
    await settle();
    assert.equal(String(reads), "1");

    // cue-states' one-second re-read saw the device catch up.
    STATES = { projectors: { state: "on" } };
    cueLive.settled();
    await settle();
    assert.equal(String(reads), "2", "the settled value waited for the next poll");
    assert.deepEqual(events[1], { type: "state", id: "projectors", state: "on" });
    await stopEverything();
  });

  test("with nobody subscribed a settled value reads nothing", async () => {
    // The re-read runs for the CALLER's next read, not for this channel, and
    // this channel has nobody to tell.
    STATES = { projectors: { state: "on" } };
    cueLive.settled();
    await settle();
    assert.equal(String(reads), "0", "a settled value read Companion for nobody");
    assert.deepEqual(events, []);
    console.log = realLog;
  });
});
