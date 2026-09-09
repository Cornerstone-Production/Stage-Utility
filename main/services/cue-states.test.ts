// Reading a bound cue pair's real state.
//
// The clock and the variable read are both injected, which is what makes the two
// things worth guarding here assertable at all:
//
//  - THE CACHE. Home Assistant polls this on a schedule and the settings page
//    polls it while it is open. Without the five second cache every poll is a
//    round of HTTP requests to Companion, and two pollers is two rounds; with a
//    cache that never expires the switch freezes on whatever it read first,
//    which is the same bug as the optimistic switch this feature exists to fix.
//  - THE LOG. A Companion nobody can reach must say so ONCE. The same line every
//    ten seconds is the day's log gone by lunchtime, and an operator scrolling
//    past 4,000 identical lines finds nothing else that happened.
//
// Every failure is a pair reading `unknown` with a reason, never a throw: this
// serves one sensor covering several pairs, and one unplugged Companion must not
// take out the rest of them.

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { cueStates, cueStatesDeps, CUE_STATES_TTL_MS } from "./cue-states.js";
import type { VariableResult } from "./companion-api.js";
import { CALL_TRIGGER_ID } from "./automation-triggers.js";
import type { Rule } from "../types/automation.js";

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

/** A pair bound to `<base>_state`, with whatever extra params the case needs. */
const pair = (base: string, on: Record<string, string> = {}): Rule[] => [
  cue(`${base}_on`, { stateVariable: `${base}_state`, ...on }),
  cue(`${base}_off`),
];

let clock = Date.parse("2026-09-09T14:00:00.000Z");
let rules: Rule[] = [];
/** What each variable answers, and every read that was made. */
let values: Record<string, VariableResult> = {};
let reads: string[] = [];
/** Set to hold each read open, so parallelism is observable. */
let gate: Promise<void> | null = null;

let logged: string[] = [];

/** Capture console for one call, so the dedupe can be asserted on real lines. */
async function withLog<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const log = console.log;
  console.warn = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

beforeEach(() => {
  clock = Date.parse("2026-09-09T14:00:00.000Z");
  rules = [];
  values = {};
  reads = [];
  gate = null;
  logged = [];
  cueStates.invalidate();
  // The dedupe memory is per-variable and deliberately survives an invalidate —
  // it is about the LOG, not the cache — so each case uses its own base name.
  cueStatesDeps.now = () => clock;
  cueStatesDeps.rules = async () => rules;
  cueStatesDeps.read = async (variable) => {
    reads.push(variable);
    if (gate) await gate;
    return values[variable] ?? { error: "no such custom variable in Companion" };
  };
});

describe("cueStates.read", () => {
  test("a value matching the on value is on, and the off value is off", async () => {
    rules = pair("projectors");
    values.projectors_state = { value: "on" };
    const first = await cueStates.read();
    assert.equal(first.ok, true);
    assert.equal(first.checkedAt, "2026-09-09T14:00:00.000Z");
    assert.deepEqual(first.states.projectors, {
      on: "projectors_on",
      off: "projectors_off",
      variable: "projectors_state",
      value: "on",
      state: "on",
    });

    values.projectors_state = { value: "off" };
    clock += CUE_STATES_TTL_MS;
    const second = await cueStates.read();
    assert.equal(second.states.projectors!.state, "off");
    assert.equal(second.ok, true);
  });

  test("the pair's own on and off values are what is compared", async () => {
    rules = pair("pj", { stateOnValue: "POWER=ON", stateOffValue: "STANDBY" });
    values.pj_state = { value: "POWER=ON" };
    assert.equal((await cueStates.read()).states.pj!.state, "on");
  });

  test("any other value is unknown, and says what it read", async () => {
    // A projector warming up reports something that is neither. Reported as off
    // it would be pressed again mid-warm-up.
    rules = pair("warming");
    values.warming_state = { value: "WARMUP" };
    const answer = await cueStates.read();
    assert.equal(answer.ok, false);
    assert.equal(answer.states.warming!.state, "unknown");
    assert.equal(answer.states.warming!.value, "WARMUP");
    assert.equal(
      answer.states.warming!.reason,
      'value "WARMUP" matches neither "on" nor "off"',
    );
  });

  test("a variable Companion does not have is unknown, with that reason", async () => {
    rules = pair("missing");
    const answer = await cueStates.read();
    assert.equal(answer.states.missing!.state, "unknown");
    assert.equal(answer.states.missing!.value, null);
    assert.equal(answer.states.missing!.reason, "no such custom variable in Companion");
  });

  test("an unreachable Companion is unknown, carrying its own error", async () => {
    rules = pair("gone");
    values.gone_state = { error: "connect ECONNREFUSED 10.0.0.5:8000" };
    const answer = await cueStates.read();
    assert.equal(answer.states.gone!.state, "unknown");
    assert.equal(answer.states.gone!.reason, "connect ECONNREFUSED 10.0.0.5:8000");
    assert.equal(answer.ok, false);
  });

  test("only BOUND pairs are in the answer, and nothing else is read", async () => {
    rules = [
      ...pair("bound"),
      cue("loose_on"),
      cue("loose_off"),
      cue("take_screens"),
    ];
    values.bound_state = { value: "on" };
    const answer = await cueStates.read();
    assert.deepEqual(Object.keys(answer.states), ["bound"]);
    assert.deepEqual(reads, ["bound_state"]);
  });

  test("no bound pairs is an empty, ok answer and no reads at all", async () => {
    rules = [cue("take_screens")];
    const answer = await cueStates.read();
    assert.deepEqual(answer.states, {});
    assert.equal(answer.ok, true);
    assert.deepEqual(reads, []);
  });

  test("one pair unknown does not make another pair unknown", async () => {
    rules = [...pair("good"), ...pair("bad")];
    values.good_state = { value: "on" };
    values.bad_state = { error: "ETIMEDOUT" };
    const answer = await cueStates.read();
    assert.equal(answer.states.good!.state, "on");
    assert.equal(answer.states.bad!.state, "unknown");
    assert.equal(answer.ok, false, "ok is every pair, not any pair");
  });
});

describe("the reads themselves", () => {
  test("every variable is read in PARALLEL", async () => {
    // Sequentially, eight pairs against an unplugged Companion is eight
    // three-second timeouts and a request Home Assistant gave up on long ago.
    rules = [...pair("a"), ...pair("b"), ...pair("c")];
    let release = () => {};
    gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = cueStates.read();
    try {
      // Several microtasks, so the rules read and the dispatch have happened —
      // and no more, so nothing has had a chance to finish. All three reads are
      // in flight before any of them has returned.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.deepEqual(reads, ["a_state", "b_state", "c_state"]);
    } finally {
      // In a finally: a failed assertion with the gate still shut leaves the
      // read hanging and the whole file times out with no line number.
      release();
      await pending;
    }
  });

  test("two pairs bound to ONE variable read it once", async () => {
    rules = [
      cue("main_on", { stateVariable: "shared_state" }),
      cue("main_off"),
      cue("south_on", { stateVariable: "shared_state" }),
      cue("south_off"),
    ];
    values.shared_state = { value: "on" };
    const answer = await cueStates.read();
    assert.deepEqual(reads, ["shared_state"]);
    assert.equal(answer.states.main!.state, "on");
    assert.equal(answer.states.south!.state, "on");
  });
});

describe("the five second cache", () => {
  test("a second call inside the window makes NO reads", async () => {
    rules = pair("cached");
    values.cached_state = { value: "on" };
    await cueStates.read();
    assert.deepEqual(reads, ["cached_state"]);

    clock += CUE_STATES_TTL_MS - 1;
    const again = await cueStates.read();
    assert.deepEqual(reads, ["cached_state"], "the second call went to Companion");
    // The same answer, including WHEN it was read — a checkedAt that moved
    // without a read would tell Home Assistant the value is fresher than it is.
    assert.equal(again.checkedAt, "2026-09-09T14:00:00.000Z");
  });

  test("a call after the window reads again", async () => {
    rules = pair("expiring");
    values.expiring_state = { value: "on" };
    await cueStates.read();
    clock += CUE_STATES_TTL_MS;
    values.expiring_state = { value: "off" };
    const answer = await cueStates.read();
    assert.deepEqual(reads, ["expiring_state", "expiring_state"]);
    assert.equal(answer.states.expiring!.state, "off");
    assert.equal(answer.checkedAt, "2026-09-09T14:00:05.000Z");
  });

  test("two callers arriving together share ONE round of reads", async () => {
    // A Home Assistant poll and the settings page landing in the same tick.
    rules = pair("shared_round");
    values.shared_round_state = { value: "on" };
    let release = () => {};
    gate = new Promise<void>((r) => {
      release = r;
    });
    const both = Promise.all([cueStates.read(), cueStates.read()]);
    release();
    const [a, b] = await both;
    assert.deepEqual(reads, ["shared_round_state"]);
    assert.equal(a.checkedAt, b.checkedAt);
  });
});

describe("the log", () => {
  test("a failure is logged once, however many times it is read", async () => {
    rules = pair("quiet");
    values.quiet_state = { error: "ETIMEDOUT" };
    await withLog(async () => {
      await cueStates.read();
      for (let i = 0; i < 5; i++) {
        clock += CUE_STATES_TTL_MS;
        await cueStates.read();
      }
    });
    assert.deepEqual(logged, ["[cues] state of quiet_state (quiet) unreadable: ETIMEDOUT"]);
  });

  test("a DIFFERENT reason is a new line", async () => {
    rules = pair("changing");
    values.changing_state = { error: "ETIMEDOUT" };
    await withLog(async () => {
      await cueStates.read();
      clock += CUE_STATES_TTL_MS;
      values.changing_state = { error: "no such custom variable in Companion" };
      await cueStates.read();
    });
    assert.deepEqual(logged, [
      "[cues] state of changing_state (changing) unreadable: ETIMEDOUT",
      "[cues] state of changing_state (changing) unreadable: no such custom variable in Companion",
    ]);
  });

  test("recovery says so, once, and a working read says nothing at all", async () => {
    rules = pair("recovers");
    values.recovers_state = { error: "ETIMEDOUT" };
    await withLog(async () => {
      await cueStates.read();
      clock += CUE_STATES_TTL_MS;
      values.recovers_state = { value: "on" };
      await cueStates.read();
      clock += CUE_STATES_TTL_MS;
      await cueStates.read();
    });
    assert.deepEqual(logged, [
      "[cues] state of recovers_state (recovers) unreadable: ETIMEDOUT",
      "[cues] state of recovers_state (recovers) is readable again",
    ]);
  });

  test("a first read that works logs nothing", async () => {
    // The ordinary case, every ten seconds, forever.
    rules = pair("fine");
    values.fine_state = { value: "on" };
    await withLog(async () => {
      await cueStates.read();
      clock += CUE_STATES_TTL_MS;
      await cueStates.read();
    });
    assert.deepEqual(logged, []);
  });
});
