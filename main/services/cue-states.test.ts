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

import {
  addSettleListener,
  cueStates,
  cueStatesDeps,
  CUE_STATES_TTL_MS,
  SETTLE_MS,
  SETTLE_POLL_MS,
} from "./cue-states.js";
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

/** A settle re-read waiting to run. The timer is injected; see tickSettle. */
interface FakeTimer {
  id: number;
  ms: number;
  fn: () => void;
}
let timers: FakeTimer[] = [];
let nextTimerId = 1;
/** Every variable the live channel was told had changed. */
let settled: string[] = [];

addSettleListener((variable) => void settled.push(variable));

/**
 * Run the one scheduled settle re-read, with the clock moved on by its delay.
 *
 * `setImmediate` and not a handful of `Promise.resolve()`s: the callback's body
 * awaits a read, and a microtask count is a number that goes stale the moment
 * an await is added to it.
 */
async function tickSettle(): Promise<void> {
  const timer = timers.shift();
  assert.ok(timer, "no settle re-read was scheduled");
  assert.equal(timer.ms, SETTLE_POLL_MS, "the settle re-read is not on a one second poll");
  clock += timer.ms;
  timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
}

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
  timers = [];
  settled = [];
  cueStates.invalidate();
  cueStates.__resetSettle();
  // The dedupe memory is per-variable and deliberately survives an invalidate —
  // it is about the LOG, not the cache — so each case uses its own base name.
  cueStatesDeps.now = () => clock;
  cueStatesDeps.rules = async () => rules;
  cueStatesDeps.read = async (variable) => {
    reads.push(variable);
    if (gate) await gate;
    return values[variable] ?? { error: "no such custom variable in Companion" };
  };
  cueStatesDeps.setTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.push({ id, ms, fn });
    return { id } as unknown as NodeJS.Timeout;
  };
  cueStatesDeps.clearTimeout = (t) => {
    const { id } = t as unknown as { id: number };
    timers = timers.filter((timer) => timer.id !== id);
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

  describe('an off value of "*" is anything that is not the on value', () => {
    // A recorder's transport variable holds one of eight words. Bound with an
    // exact off value it reads unknown in six of them; bound with `*` the on
    // value is the only one spelled out. `unknown` then means only "no such
    // variable" or "no Companion".
    test("the on value still reads on", async () => {
      rules = pair("deck", { stateOnValue: "Record", stateOffValue: "*" });
      values.deck_state = { value: "Record" };
      const answer = await cueStates.read();
      assert.equal(answer.states.deck!.state, "on");
      assert.equal(answer.ok, true);
    });

    test("any other non-empty value reads off, with no reason", async () => {
      rules = pair("deck", { stateOnValue: "Record", stateOffValue: "*" });
      values.deck_state = { value: "Preview" };
      const answer = await cueStates.read();
      assert.equal(answer.states.deck!.state, "off");
      assert.equal(answer.states.deck!.value, "Preview");
      assert.equal(answer.states.deck!.reason, undefined);
      assert.equal(answer.ok, true);
    });

    test("an EMPTY value reads off — the variable was read", async () => {
      // What a module writes for a device it has not heard from yet. It is
      // certainly not recording, and it is not a failure to read either.
      rules = pair("deck", { stateOnValue: "Record", stateOffValue: "*" });
      values.deck_state = { value: "" };
      const answer = await cueStates.read();
      assert.equal(answer.states.deck!.state, "off");
      assert.equal(answer.states.deck!.value, "");
      assert.equal(answer.ok, true);
    });

    test("a MISSING variable is still unknown — `*` matches a value, not a failure", async () => {
      rules = pair("deck", { stateOnValue: "Record", stateOffValue: "*" });
      const answer = await cueStates.read();
      assert.equal(answer.states.deck!.state, "unknown");
      assert.equal(answer.states.deck!.value, null);
      assert.equal(answer.states.deck!.reason, "no such custom variable in Companion");
      assert.equal(answer.ok, false);
    });
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

  test("a read that REJECTS is that pair's unknown, not everybody's", async () => {
    // `read` is documented as never throwing and the one implementation of it
    // means to be — but under Promise.all one rejection rejected the batch, so
    // `cueStates.read()` threw despite saying it never does and the route
    // answered 500 for every pair over one of them.
    rules = [...pair("ok_one"), ...pair("thrower"), ...pair("ok_two")];
    values.ok_one_state = { value: "on" };
    values.ok_two_state = { value: "off" };
    const answered = cueStatesDeps.read;
    cueStatesDeps.read = async (variable) => {
      if (variable === "thrower_state") throw new Error("secrets.bin is unreadable");
      return answered(variable);
    };
    const answer = await cueStates.read();
    assert.equal(answer.states.ok_one!.state, "on");
    assert.equal(answer.states.ok_two!.state, "off");
    assert.equal(answer.states.thrower!.state, "unknown");
    assert.equal(answer.states.thrower!.reason, "secrets.bin is unreadable");
    assert.equal(answer.ok, false);
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

// ── Keys that are not ordinary ────────────────────────────────────────────────
//
// The key in the answer is the pair's BASE, which is half of a cue name out of
// the rules file. `record["__proto__"] = row` does not add a property: it
// replaces the object's prototype. The pair then vanishes from the answer with
// nothing saying so.
//
// HOW FAR EACH KEY REACHES, measured against the real route rather than assumed:
// `constructor` and `prototype` are valid cue names, so a pair based on either
// arrives through POST /api/automation/rules — but as own properties on a record
// they are harmless, and the bug they cause is one level up, on the READ (see
// cue-pair-state.test.tsx). `__proto__` is the one that breaks the write, and
// `__proto___on` is refused by CUE_NAME_RE — a leading underscore and a double
// underscore are both out — so it takes a hand-edited automation-rules.json to
// get there. That is a path this repo treats as real: a hand-edited rules file
// is why a state binding is read off the `_off` half as a fallback three modules
// away. Cheap to hold, and it is the difference between the pair working and the
// pair silently not existing.
describe("a pair whose base is a prototype key", () => {
  test("__proto__ is an OWN property of the answer, and a real row", async () => {
    rules = pair("__proto__");
    values.__proto___state = { value: "on" };
    const answer = await cueStates.read();

    assert.equal(Object.hasOwn(answer.states, "__proto__"), true, "the pair is not in the answer");
    assert.deepEqual(Object.keys(answer.states), ["__proto__"]);
    // Read through a Map: `answer.states.__proto__` and `.constructor` resolve
    // to Object's own members in the type checker, whatever the value is.
    assert.equal(new Map(Object.entries(answer.states)).get("__proto__")?.state, "on");
    assert.equal(answer.ok, true);
    // The record itself is an ordinary object, not one wearing the row as its
    // prototype.
    assert.equal(Object.getPrototypeOf(answer.states), Object.prototype);
    assert.equal((({}) as Record<string, unknown>).variable, undefined, "Object.prototype was polluted");

    // And it survives the wire, which is the only thing Home Assistant sees.
    const wire = JSON.parse(JSON.stringify(answer)) as { states: Record<string, unknown> };
    assert.equal(Object.hasOwn(wire.states, "__proto__"), true, "the pair is not in the JSON");
  });

  test("constructor and prototype bases are ordinary rows too", async () => {
    rules = [...pair("constructor"), ...pair("prototype")];
    values.constructor_state = { value: "on" };
    values.prototype_state = { value: "off" };
    const answer = await cueStates.read();
    assert.deepEqual(Object.keys(answer.states).sort(), ["constructor", "prototype"]);
    const rows = new Map(Object.entries(answer.states));
    assert.equal(rows.get("constructor")?.state, "on");
    assert.equal(rows.get("prototype")?.state, "off");
    assert.equal(answer.ok, true);
  });
});

// ── The settle window ─────────────────────────────────────────────────────────
//
// Companion polls a smart plug on its own interval, so for a second or two after
// a press the variable still holds the value from before it. Two things follow
// from that, and both are what this section holds:
//
//  - the pair is marked `settling` with what was COMMANDED, so an integration
//    can show the command rather than a reading that is known to be stale;
//  - the commanded variable is re-read every second until it agrees, so the
//    truth arrives about a second after the device moves rather than at the next
//    five-second tick.
//
// The clock and the timer are both injected. `setTimeout` mocked at the runtime
// would not do: what has to be asserted is the DELAY the re-read asked for and
// that nothing is left scheduled once the window closes, and both are read
// straight off the recorded call.
describe("the settle window", () => {
  /** A press of `<base>_on`, as the engine reports one. */
  const commandOn = (base: string) =>
    cueStates.noteCommand({ base, want: "on", variable: `${base}_state`, wantValue: "on" });

  test("a row inside the window says what was commanded, and drops it after", async () => {
    rules = pair("plug");
    values.plug_state = { value: "off" };
    const before = (await cueStates.read()).states.plug!;
    assert.equal(before.settling, undefined);
    assert.equal(before.commanded, undefined);

    commandOn("plug");
    const during = (await cueStates.read()).states.plug!;
    assert.equal(during.settling, true);
    assert.equal(during.commanded, "on");
    // The READING is still reported as it is. The row does not lie about the
    // variable; it says the variable may be behind.
    assert.equal(during.value, "off");
    assert.equal(during.state, "off");

    clock += SETTLE_MS;
    const after = (await cueStates.read()).states.plug!;
    assert.equal(after.settling, undefined, "the row still claims to be settling after the window");
    assert.equal(after.commanded, undefined);
  });

  test("the fields are not baked into the five second cache", async () => {
    // The cache is served for five seconds and the window is eight, so a read
    // taken NEAR THE END of a window and cached with `settling` written into it
    // goes on claiming it for seconds after the window closed — which is the
    // point at which an integration should be trusting the reading again.
    rules = pair("cachedsettle");
    values.cachedsettle_state = { value: "on" };
    cueStates.noteCommand({
      base: "cachedsettle",
      want: "off",
      variable: "cachedsettle_state",
      wantValue: "off",
    });

    // One second before the window closes: a real read, cached from here.
    clock += SETTLE_MS - 1000;
    assert.equal((await cueStates.read()).states.cachedsettle!.settling, true);

    // The window has closed; the cached ANSWER has not.
    clock += 1000;
    const row = (await cueStates.read()).states.cachedsettle!;
    assert.equal(row.settling, undefined, "a cached row still claims to be settling");
    assert.equal(row.commanded, undefined);
  });

  test("commandedWithin lapses exactly at the window", () => {
    commandOn("lapsing");
    const at = clock;
    assert.equal(cueStates.commandedWithin("lapsing", at + SETTLE_MS - 1)?.want, "on");
    assert.equal(cueStates.commandedWithin("lapsing", at + SETTLE_MS), null);
    assert.equal(cueStates.commandedWithin("never-pressed", at), null);
  });

  test("the commanded variable is re-read every second, and stops when it agrees", async () => {
    rules = pair("lag");
    values.lag_state = { value: "off" };
    await cueStates.read();
    reads = [];

    commandOn("lag");
    await withLog(async () => {
      // Companion has not caught up: the value is still what it was.
      await tickSettle();
      assert.deepEqual(reads, ["lag_state"]);
      assert.equal(timers.length, 1, "the re-read gave up while the value was still stale");
      assert.deepEqual(logged, []);

      values.lag_state = { value: "on" };
      await tickSettle();
    });
    assert.deepEqual(reads, ["lag_state", "lag_state"]);
    assert.deepEqual(logged, ["[cues] state of lag_state settled to on after 2 s"]);
    assert.equal(timers.length, 0, "a timer outlived the value it was waiting for");
  });

  test("a value that never catches up stops at the window, and says so", async () => {
    rules = pair("stuck");
    values.stuck_state = { value: "off" };
    await cueStates.read();
    reads = [];

    commandOn("stuck");
    await withLog(async () => {
      for (let i = 0; i < SETTLE_MS / SETTLE_POLL_MS; i++) await tickSettle();
    });
    assert.equal(reads.length, SETTLE_MS / SETTLE_POLL_MS);
    assert.deepEqual(logged, ["[cues] state of stuck_state did not settle within 8 s"]);
    assert.equal(timers.length, 0, "the re-read is still running past the settle window");
  });

  test("a read that fails is not there yet, and the window still ends", async () => {
    // A read never throws in principle; when it does, or when the variable has
    // gone missing, the loop must not stop early and must not run forever.
    rules = pair("broken");
    commandOn("broken");
    values.broken_state = { error: "ETIMEDOUT" };
    await withLog(async () => {
      for (let i = 0; i < SETTLE_MS / SETTLE_POLL_MS; i++) await tickSettle();
    });
    assert.deepEqual(logged, ["[cues] state of broken_state did not settle within 8 s"]);
    assert.equal(timers.length, 0);
  });

  test("only the commanded variable is re-read", async () => {
    // The whole point of the fast re-read is that it costs one variable. A round
    // of every bound pair every second for eight seconds is the standing poll
    // this module exists not to have.
    rules = [...pair("moved"), ...pair("still")];
    values.moved_state = { value: "off" };
    values.still_state = { value: "on" };
    await cueStates.read();
    reads = [];

    commandOn("moved");
    await tickSettle();
    assert.deepEqual(reads, ["moved_state"]);
  });

  test("the live channel is told the moment the value changes, and only then", async () => {
    rules = pair("pushes");
    values.pushes_state = { value: "off" };
    await cueStates.read();

    commandOn("pushes");
    await withLog(async () => {
      await tickSettle();
      assert.deepEqual(settled, [], "an unchanged value was pushed as a change");

      values.pushes_state = { value: "on" };
      await tickSettle();
    });
    assert.deepEqual(settled, ["pushes_state"]);
  });

  test("a change part way to the commanded value is pushed too, and polling goes on", async () => {
    // A projector answers WARMUP before it answers on. An integration showing
    // the reason has to be told, and the poll must not stop on it.
    rules = pair("warms");
    values.warms_state = { value: "off" };
    await cueStates.read();

    commandOn("warms");
    values.warms_state = { value: "WARMUP" };
    await tickSettle();
    assert.deepEqual(settled, ["warms_state"]);
    assert.equal(timers.length, 1, "the re-read stopped on a value that was not commanded");
  });

  test("a change drops the cached answer, so the next read is the new value", async () => {
    // The cache is what defect (2) arrives through: a poll landed just after
    // the press, cached the pre-press value, and the value that settled a
    // second later was invisible for the rest of the five seconds — long
    // enough for Home Assistant to push the switch back and invite another tap.
    rules = pair("fresh");
    values.fresh_state = { value: "off" };
    commandOn("fresh");
    // A poller reads while the device is still catching up. This is the answer
    // that must not be served once the real value lands.
    assert.equal((await cueStates.read()).states.fresh!.state, "off");

    values.fresh_state = { value: "on" };
    await tickSettle();
    // Still well inside the five second cache.
    assert.equal(
      (await cueStates.read()).states.fresh!.state,
      "on",
      "the settled value was hidden behind the cached answer",
    );
  });

  test("a second command on the same variable restarts ONE loop", async () => {
    // Somebody flipping the switch in Home twice. Two loops on one variable is
    // two reads a second and two settled lines for one device.
    rules = pair("twice");
    values.twice_state = { value: "off" };
    commandOn("twice");
    cueStates.noteCommand({
      base: "twice",
      want: "off",
      variable: "twice_state",
      wantValue: "off",
    });
    assert.equal(timers.length, 1, "the first re-read is still scheduled beside the second");

    // And the LAST command is what it is waiting for: the value is already off,
    // so it settles at once.
    await withLog(tickSettle);
    assert.deepEqual(logged, ["[cues] state of twice_state settled to off after 1 s"]);
    assert.equal(timers.length, 0);
  });

  test("__resetSettle cancels the timer as well as the command", async () => {
    rules = pair("cancelled");
    values.cancelled_state = { value: "off" };
    commandOn("cancelled");
    assert.equal(timers.length, 1);
    cueStates.__resetSettle();
    assert.equal(timers.length, 0, "a cancelled settle re-read is still scheduled");
    assert.equal(cueStates.commandedWithin("cancelled", clock), null);
    assert.equal((await cueStates.read()).states.cancelled!.settling, undefined);
  });
});
