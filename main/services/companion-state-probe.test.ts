// Probing a connection for candidate variables, and watching a press.
//
// The I/O half. Every read and both timers are injected, which is what makes an
// eight-second settle window assertable in a millisecond and a Companion
// unreachable on demand.
//
// What is guarded here is what the probe COSTS and what it WRITES, because both
// failures are quiet:
//
//  - the URLs. A probe that asked for every candidate on every pair every pass
//    is 19 requests per connection per hour per pair at a Companion that is
//    also running a service. The read stub records what was asked for, and the
//    tests assert the exact refs.
//  - a Companion that cannot be reached must change NOTHING. Recorded as "none
//    of these names exist", a pair would never be probed again inside the hour
//    and the feature would be off for it with nothing saying so.
//  - the press path must be free of Companion traffic for the pairs that are
//    NOT learning, which is nearly every pair in the building.
//
// NOTHING HERE PRESSES ANYTHING, and there is no press in the module under test
// at all: every observation rides a press somebody else made.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  __resetWatches,
  notePressForLearning,
  probeRefs,
  probeStateCandidates,
  probeTargets,
  stateProbeDeps,
} from "./companion-state-probe.js";
import { CANDIDATE_VARIABLES, learningParams, parseLearning } from "./companion-state-learn.js";
import { SETTLE_MS, SETTLE_POLL_MS } from "./cue-states.js";
import { cuePairs } from "./cue-pairs.js";
import { CALL_TRIGGER_ID } from "./automation-triggers.js";
import type { CompanionButton } from "./companion-export.js";
import type { Rule } from "../types/automation.js";

const real = { ...stateProbeDeps };

let clock = Date.parse("2026-09-10T14:00:00.000Z");
/** What each ref answers. Anything absent is Companion's 404 sentence. */
let values: Record<string, string> = {};
/** Every ref that was read, in order — what an assert on the cost reads. */
let reads: string[] = [];
/** Set to make every read fail as a transport failure rather than a 404. */
let unreachable = "";
/** Every trigger patch that was written. */
let writes: { ruleId: string; patch: Record<string, string> }[] = [];
/** Set to make the write fail. */
let writeFails = "";
/** The pending injected timers, oldest first. */
let timers: { at: number; fn: () => void }[] = [];

/** Let every pending read, `.then` and write settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

/**
 * Run every timer that comes due within `toMs`, advancing the clock to each.
 *
 * FLUSHES FIRST, every pass. The watch schedules its next read from inside a
 * promise callback, so a loop that only looked at the timers already queued saw
 * an empty list and advanced the clock past the whole window without running a
 * single poll — which is a test that proves nothing while passing.
 */
async function tick(toMs: number): Promise<void> {
  const until = clock + toMs;
  // A bounded loop: the watch schedules at most one timer at a time, and the
  // cap is the settle window over the poll interval with room over it, so a bug
  // that schedules forever fails rather than hangs.
  for (let i = 0; i < 64; i++) {
    await flush();
    const next = timers[0];
    if (!next || next.at > until) break;
    timers.shift();
    clock = next.at;
    next.fn();
  }
  clock = until;
  await flush();
}

beforeEach(() => {
  clock = Date.parse("2026-09-10T14:00:00.000Z");
  values = {};
  reads = [];
  unreachable = "";
  writes = [];
  writeFails = "";
  timers = [];
  stateProbeDeps.now = () => clock;
  stateProbeDeps.read = async (ref) => {
    reads.push(ref);
    if (unreachable) return { error: unreachable };
    return ref in values
      ? { value: values[ref]! }
      : { error: `no such variable ${ref} in Companion` };
  };
  stateProbeDeps.setTimeout = (fn, ms) => {
    timers.push({ at: clock + ms, fn });
    timers.sort((a, b) => a.at - b.at);
    return { __id: timers.length } as unknown as NodeJS.Timeout;
  };
  stateProbeDeps.clearTimeout = () => {
    // The tests drive the timers by hand; a cancelled one is simply never run
    // because the watch it belonged to is no longer the current one.
  };
  stateProbeDeps.updateTrigger = async (ruleId, patch) => {
    if (writeFails) throw new Error(writeFails);
    writes.push({ ruleId, patch });
  };
});

afterEach(() => {
  __resetWatches();
  Object.assign(stateProbeDeps, real);
});

function cue(name: string, params: Record<string, string | number> = {}): Rule {
  return {
    id: `id-${name}`,
    name,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name, ...params } },
    conditions: [],
    action: { id: "companion.press", params: { page: 1, row: 0, col: 1 } },
    cooldownSec: 0,
    oncePerService: false,
  };
}

const button = (over: Partial<CompanionButton> = {}): CompanionButton => ({
  page: 1,
  pageId: "page-one",
  pageName: "Room A",
  row: 0,
  col: 1,
  label: "Rack ON",
  drives: ["yamaha-rcp"],
  actionIds: ["a1"],
  stateSource: null,
  learnConnections: ["Rack"],
  ...over,
});

/** A pair of rules and the found-button map the reconcile hands the probe. */
function pairAnd(
  onParams: Record<string, string | number> = {},
  buttons: { on?: Partial<CompanionButton>; off?: Partial<CompanionButton> } = {},
) {
  const rules = [cue("rack_on", onParams), cue("rack_off")];
  const found = new Map<string, CompanionButton>([
    ["id-rack_on", button(buttons.on)],
    ["id-rack_off", button({ col: 2, label: "Rack OFF", ...buttons.off })],
  ]);
  return { pairs: cuePairs(rules), found };
}

describe("which pairs get probed", () => {
  test("a pair with no binding whose connection has no table row", () => {
    const { pairs, found } = pairAnd();
    assert.deepEqual(
      probeTargets(pairs, found, clock).map((t) => [t.pair.base, t.labels]),
      [["rack", ["Rack"]]],
    );
  });

  test("NEVER a pair with an explicit binding", () => {
    // THE GUARD. An operator who chose a custom variable their own buttons set
    // meant it, and a housekeeping sweep is not permission to replace it — nor
    // to spend 19 requests an hour finding out it could have.
    const bound = pairAnd({ stateVariable: "rack_state" });
    assert.deepEqual(probeTargets(bound.pairs, bound.found, clock), []);
    // On the OFF half too: cuePairs falls back to it, so a hand-edited rules
    // file with the binding on that side must stop this as well.
    const rules = [cue("rack_on"), cue("rack_off", { stateVariable: "rack_state" })];
    const found = new Map([
      ["id-rack_on", button()],
      ["id-rack_off", button({ col: 2 })],
    ]);
    assert.deepEqual(probeTargets(cuePairs(rules), found, clock), []);
  });

  test("never a pair the verified table already answers for", () => {
    const inferred = {
      variable: "Plug:power_state",
      onValue: "On",
      offValue: "Off",
      moduleId: "tplink-kasasmartplug",
    };
    const { pairs, found } = pairAnd({}, { on: { stateSource: inferred, learnConnections: [] } });
    assert.deepEqual(probeTargets(pairs, found, clock), []);
  });

  test("never a pair whose button is missing from the export", () => {
    const rules = [cue("rack_on"), cue("rack_off")];
    assert.deepEqual(probeTargets(cuePairs(rules), new Map(), clock), []);
  });

  test("never a connection whose label cannot be named in a variable reference", () => {
    // Companion labels are sanitised, but an older document can hold a label
    // with a space in it. There is nothing to ask for, and recording it as
    // probed would write to the rules file and log a line every pass.
    const { pairs, found } = pairAnd(
      {},
      { on: { learnConnections: ["Old Thing"] }, off: { learnConnections: ["Old Thing"] } },
    );
    assert.deepEqual(probeTargets(pairs, found, clock), []);
  });
});

describe("probing", () => {
  test("records only the names that exist, in candidate order", async () => {
    values = { "Rack:status": "Standby", "Rack:power": "1" };
    const probed = await probeRefs(["Rack:status", "Rack:mute", "Rack:power"]);
    assert.deepEqual(probed?.existing, ["Rack:status", "Rack:power"]);
    assert.deepEqual(probed?.values, { "Rack:status": "Standby", "Rack:power": "1" });
    assert.deepEqual(reads, ["Rack:status", "Rack:mute", "Rack:power"]);
  });

  test("an unreachable Companion changes nothing at all", async () => {
    // THE GUARD. `{ existing: [] }` here would be recorded as "this connection
    // publishes none of these names", and the hourly cap would then keep the
    // pair from ever being probed again — the feature off for it, silently.
    unreachable = "connect ECONNREFUSED 10.0.0.5:8000";
    assert.equal(await probeRefs(["Rack:status"]), null);
  });

  test("asks each candidate for each connection, exactly once", async () => {
    const { pairs, found } = pairAnd(
      {},
      { on: { learnConnections: ["Rack"] }, off: { learnConnections: ["Rack", "Deck"] } },
    );
    values = { "Rack:status": "Standby" };
    const outcomes = await probeStateCandidates(pairs, found);
    assert.equal(reads.length, CANDIDATE_VARIABLES.length * 2, "one GET per name per connection");
    assert.equal(new Set(reads).size, reads.length, "no name asked for twice");
    assert.deepEqual(outcomes[0]?.patch.stateCandidates, "Rack:status");
    assert.match(outcomes[0]!.log!, /^\[cues\] pair rack: no state source in the table; watching 1 candidate\(s\) — Rack:status$/);
    // The value read at probe time is the baseline the first press compares
    // against, so a candidate that has never moved is not later mistaken for a
    // two-state variable.
    assert.deepEqual(parseLearning(outcomes[0]!.patch).observed, {
      "Rack:status": { values: ["Standby"] },
    });
  });

  test("writes nothing and logs nothing when Companion is unreachable", async () => {
    unreachable = "fetch failed";
    const { pairs, found } = pairAnd();
    assert.deepEqual(await probeStateCandidates(pairs, found), []);
  });

  test("records the timestamp even when no candidate exists, so it waits an hour", async () => {
    const { pairs, found } = pairAnd();
    const first = await probeStateCandidates(pairs, found);
    assert.equal(first[0]?.patch.stateCandidates, "");
    assert.match(first[0]!.log!, /none of the 19 candidate names exist on Rack$/);
    const probedAt = parseLearning(first[0]!.patch).probedAt;
    assert.equal(probedAt, new Date(clock).toISOString());

    // With that recorded, the next pass inside the hour asks for nothing.
    reads = [];
    const again = pairAnd(first[0]!.patch);
    clock += 59 * 60 * 1000;
    assert.deepEqual(await probeStateCandidates(again.pairs, again.found), []);
    assert.deepEqual(reads, []);

    // And an hour later it asks again.
    clock += 2 * 60 * 1000;
    assert.equal((await probeStateCandidates(again.pairs, again.found)).length, 1);
    assert.equal(reads.length, CANDIDATE_VARIABLES.length);
  });
});

describe("watching a press", () => {
  const learningOn = (candidates: string[], observed: Record<string, { values: string[] }> = {}) =>
    learningParams(candidates, { attempts: 0, observed, probedAt: new Date(clock).toISOString() });

  test("reads only the pair's own candidates, and only after the press", async () => {
    // The cost of the press path. A pre-press read would put a Companion round
    // trip in front of every learning pair's voice call for nothing the caller
    // needs, and Companion polls the device on its own interval anyway — the
    // reason the settle window exists at all.
    values = { "Rack:status": "Standby" };
    notePressForLearning({
      ruleId: "id-rack_on",
      base: "rack",
      want: "on",
      params: learningOn(["Rack:status"]),
    });
    await tick(0);
    assert.deepEqual(reads, ["Rack:status"], "the before snapshot, and nothing else");
  });

  test("does nothing for a pair with no candidates", async () => {
    // Nearly every press in the building. No Companion traffic, no timer.
    notePressForLearning({ ruleId: "id-rack_on", base: "rack", want: "on", params: {} });
    await tick(SETTLE_MS);
    assert.deepEqual(reads, []);
    assert.deepEqual(timers, []);
    assert.deepEqual(writes, []);
  });

  test("does nothing once learning has stopped", async () => {
    const stopped = learningParams(["Rack:status"], {
      attempts: 2,
      observed: {},
      stopped: "bound",
    });
    notePressForLearning({ ruleId: "id-rack_on", base: "rack", want: "on", params: stopped });
    await tick(SETTLE_MS);
    assert.deepEqual(reads, []);
    assert.deepEqual(writes, []);
  });

  test("an ON press then an OFF press binds, with the right two values", async () => {
    // The whole feature, end to end over the injected clock: a device that
    // catches up two seconds after each press.
    values = { "Rack:status": "Standby" };
    notePressForLearning({
      ruleId: "id-rack_on",
      base: "rack",
      want: "on",
      params: learningOn(["Rack:status"]),
    });
    await tick(0);
    values["Rack:status"] = "Active";
    await tick(SETTLE_POLL_MS * 3);
    assert.equal(writes.length, 1, "the first press records what it saw");
    assert.equal(writes[0]?.patch.stateVariable, undefined, "one direction is not a binding");
    const after = parseLearning(writes[0]!.patch);
    assert.deepEqual(after.observed["Rack:status"], { on: "Active", values: ["Active"] });

    notePressForLearning({
      ruleId: "id-rack_on",
      base: "rack",
      want: "off",
      params: writes[0]!.patch,
    });
    await tick(0);
    values["Rack:status"] = "Standby";
    await tick(SETTLE_POLL_MS * 3);
    assert.equal(writes.length, 2);
    assert.deepEqual(
      {
        variable: writes[1]!.patch.stateVariable,
        on: writes[1]!.patch.stateOnValue,
        off: writes[1]!.patch.stateOffValue,
      },
      { variable: "Rack:status", on: "Active", off: "Standby" },
    );
    // The candidates are cleared and learning is over: an ordinary binding
    // from here on, and never re-probed unless the operator asks.
    assert.equal(writes[1]!.patch.stateCandidates, "");
    assert.equal(parseLearning(writes[1]!.patch).stopped, "bound");
  });

  test("stops polling a candidate the moment it moves", async () => {
    // Re-reading a candidate whose settled value is already known costs seven
    // more GETs to learn nothing — and it only shows up with a SECOND candidate
    // still moving, because a window in which everything has moved ends early.
    values = { "Rack:status": "Standby", "Rack:mute": "0" };
    notePressForLearning({
      ruleId: "id-rack_on",
      base: "rack",
      want: "on",
      params: learningOn(["Rack:status", "Rack:mute"]),
    });
    await tick(0);
    values["Rack:status"] = "Active";
    await tick(SETTLE_MS + SETTLE_POLL_MS);
    assert.deepEqual(
      reads.filter((r) => r === "Rack:status"),
      ["Rack:status", "Rack:status"],
      "the before read and the one poll that saw it move",
    );
    assert.equal(
      reads.filter((r) => r === "Rack:mute").length,
      1 + SETTLE_MS / SETTLE_POLL_MS,
      "the static one is polled to the end of the window",
    );
  });

  test("a candidate that never moves is polled to the end of the window and ruled out", async () => {
    values = { "Rack:status": "Standby" };
    notePressForLearning({
      ruleId: "id-rack_on",
      base: "rack",
      want: "on",
      params: learningOn(["Rack:status"]),
    });
    await tick(SETTLE_MS + SETTLE_POLL_MS);
    assert.equal(reads.length, 1 + SETTLE_MS / SETTLE_POLL_MS, "one read per second, once each");
    assert.equal(writes.length, 1);
    assert.deepEqual(parseLearning(writes[0]!.patch).observed, {}, "nothing was learned");
    assert.equal(parseLearning(writes[0]!.patch).attempts, 1, "the press is still spent");
  });

  test("three presses that learn nothing stop learning, with a line", async () => {
    const lines: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      values = { "Rack:status": "Standby" };
      let params: Record<string, string | number> = learningOn(["Rack:status"]);
      for (let i = 0; i < 3; i++) {
        notePressForLearning({ ruleId: "id-rack_on", base: "rack", want: "on", params });
        await tick(SETTLE_MS + SETTLE_POLL_MS);
        params = writes.at(-1)!.patch;
      }
    } finally {
      console.warn = realWarn;
    }
    assert.equal(writes.length, 3);
    assert.equal(parseLearning(writes[2]!.patch).stopped, "gave-up");
    assert.deepEqual(lines, [
      "[cues] pair rack: could not learn a state source after 3 presses; pick one on the rule",
    ]);
  });

  test("a second press inside the window restarts the watch rather than running two", async () => {
    values = { "Rack:status": "Standby" };
    const params = learningOn(["Rack:status"]);
    notePressForLearning({ ruleId: "id-rack_on", base: "rack", want: "on", params });
    await tick(SETTLE_POLL_MS);
    notePressForLearning({ ruleId: "id-rack_on", base: "rack", want: "off", params });
    values["Rack:status"] = "Idle";
    await tick(SETTLE_MS + SETTLE_POLL_MS);
    // ONE write, for the second press's direction. Two watches on one pair
    // would attribute the same movement to both directions and bind a variable
    // from a single press.
    assert.equal(writes.length, 1);
    assert.deepEqual(parseLearning(writes[0]!.patch).observed["Rack:status"], {
      off: "Idle",
      values: ["Idle"],
    });
  });

  test("a failed write says what was lost rather than dropping it", async () => {
    const lines: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      values = { "Rack:status": "Standby" };
      writeFails = "EROFS: read-only file system";
      notePressForLearning({
        ruleId: "id-rack_on",
        base: "rack",
        want: "on",
        params: learningOn(["Rack:status"]),
      });
      await tick(0);
      values["Rack:status"] = "Active";
      await tick(SETTLE_POLL_MS * 2);
    } finally {
      console.warn = realWarn;
    }
    assert.deepEqual(writes, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[cues\] pair rack: could not record what it learned: EROFS/);
  });

  test("an unreachable Companion mid-window learns nothing and spends the press", async () => {
    values = { "Rack:status": "Standby" };
    notePressForLearning({
      ruleId: "id-rack_on",
      base: "rack",
      want: "on",
      params: learningOn(["Rack:status"]),
    });
    await tick(0);
    unreachable = "fetch failed";
    await tick(SETTLE_MS + SETTLE_POLL_MS);
    assert.equal(writes.length, 1);
    assert.deepEqual(parseLearning(writes[0]!.patch).observed, {});
  });
});
