// Learning a state source for a device the verified table has no row for.
//
// The pure half: which names are worth probing, which connections are worth
// probing at all, and — the whole risk of the feature — WHEN a watched variable
// has earned a binding.
//
// Every guard here is about binding the wrong thing, because that failure is
// silent from the operator's side. A switch bound to a variable that merely
// reacted to the press reads on whatever the device is doing, which is exactly
// the optimism the binding exists to remove, one system further along:
//
//  - one direction is not enough. A `last_command` variable moves after ON and
//    never after OFF.
//  - a third value disqualifies. A `status` that reads Standby/Warming/Active
//    bound on its first two readings reads unknown every time the device passes
//    through the third.
//  - an explicitly bound pair is never touched at all. An operator who chose a
//    custom variable meant it.
//  - it has to STOP. A pair that will never learn must not probe 19 names an
//    hour for the rest of the year.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CANDIDATE_VARIABLES,
  LEARN_MAX_ATTEMPTS,
  candidateRefs,
  gaveUpLog,
  learnableOffer,
  learnAgainParams,
  learnedLog,
  learningHint,
  learningParams,
  observePress,
  parseCandidates,
  parseLearning,
  pickCandidate,
  shouldProbe,
  type LearningState,
} from "./companion-state-learn.js";
import { STATE_SOURCES, learnableConnections } from "./companion-state-source.js";
import type { ExportConnection } from "./companion-state-source.js";

/** A press's readings, with everything unmentioned unchanged. */
function press(
  want: "on" | "off",
  moves: Record<string, [string, string]>,
): { want: "on" | "off"; before: Record<string, string>; after: Record<string, string> } {
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const [ref, [from, to]] of Object.entries(moves)) {
    before[ref] = from;
    after[ref] = to;
  }
  return { want, before, after };
}

const fresh: LearningState = { attempts: 0, observed: {} };

describe("the candidate names", () => {
  test("include every name the verified table knows", () => {
    // The table's own names are the best evidence about what a Companion module
    // calls this, so a row added to STATE_SOURCES must join the probe list
    // without anybody remembering to. Asserted against the table rather than
    // against a literal list, which is what makes that automatic.
    const fromTable = new Set(
      Object.values(STATE_SOURCES).flatMap((rows) => rows.map((r) => r.name)),
    );
    for (const name of fromTable) assert.ok(CANDIDATE_VARIABLES.includes(name), name);
  });

  test("hold no duplicates, so a name is never probed twice", () => {
    // The two groups are CONCATENATED, not de-duplicated: a name written into
    // the common shapes that the table already supplies would be two GETs for
    // one answer, and it would make the group read off the table dead weight
    // nobody would notice was gone.
    assert.equal(new Set(CANDIDATE_VARIABLES).size, CANDIDATE_VARIABLES.length);
  });

  test("carry the common shapes a module author reaches for", () => {
    for (const name of ["state", "on_off", "is_on", "active", "enabled", "mute", "connected"]) {
      assert.ok(CANDIDATE_VARIABLES.includes(name), name);
    }
  });

  test("become one ref per name per connection, in list order", () => {
    const refs = candidateRefs(["Yamaha-Rack", "Smartview"]);
    assert.equal(refs.length, CANDIDATE_VARIABLES.length * 2);
    assert.equal(refs[0], `Yamaha-Rack:${CANDIDATE_VARIABLES[0]}`);
    assert.equal(refs.at(-1), `Smartview:${CANDIDATE_VARIABLES.at(-1)}`);
  });

  test("drop a label Companion's own reference grammar refuses", () => {
    // A label with a dot cannot be named in `$(label:name)` and cannot be read
    // back through /api/variable at all. Dropped rather than sent, so the probe
    // never spends 19 requests on 404s for the wrong reason.
    assert.deepEqual(candidateRefs(["has.a.dot"]), []);
    assert.equal(candidateRefs(["Fine-1"]).length, CANDIDATE_VARIABLES.length);
  });
});

describe("which connections can be learned", () => {
  const connections: Record<string, ExportConnection> = {
    plug: { label: "VCR-Light", moduleId: "tplink-kasasmartplug" },
    console: { label: "Yamaha-Rack", moduleId: "yamaha-rcp" },
    monitor: { label: "Smartview", moduleId: "bmd-smartview" },
    nameless: { label: "", moduleId: "yamaha-rcp" },
  };

  test("are the ones no table row covers", () => {
    assert.deepEqual(
      learnableConnections(
        { actions: [{ connectionId: "console", definitionId: "recall" }], feedbacks: [] },
        connections,
      ),
      ["Yamaha-Rack"],
    );
  });

  test("exclude a module the table already answers for", () => {
    // The whole point of the table is that its rows are verified. A kasa plug
    // has a row, so probing it could only replace a verified answer with a
    // guessed one.
    assert.deepEqual(
      learnableConnections(
        { actions: [{ connectionId: "plug", definitionId: "power" }], feedbacks: [] },
        connections,
      ),
      [],
    );
  });

  test("exclude a connection with no label", () => {
    // A variable reference names a connection by its label. There is nothing to
    // ask Companion for.
    assert.deepEqual(
      learnableConnections(
        { actions: [{ connectionId: "nameless", definitionId: "recall" }], feedbacks: [] },
        connections,
      ),
      [],
    );
  });

  test("come from the feedbacks as well, actions first and de-duplicated", () => {
    assert.deepEqual(
      learnableConnections(
        {
          actions: [
            { connectionId: "monitor", definitionId: "set" },
            { connectionId: "console", definitionId: "recall" },
          ],
          feedbacks: [
            { connectionId: "console", definitionId: "level" },
            { connectionId: "monitor", definitionId: "state" },
          ],
        },
        connections,
      ),
      ["Smartview", "Yamaha-Rack"],
    );
  });
});

describe("what the import offer says", () => {
  const half = (over: { stateSource?: unknown; learnConnections?: string[] } = {}) => ({
    stateSource: over.stateSource ?? null,
    learnConnections: over.learnConnections ?? [],
  });

  test("a pair whose connection has no table row will be learned", () => {
    assert.equal(learnableOffer([half({ learnConnections: ["Rack"] }), half()]), true);
    assert.equal(learnableOffer([half(), half({ learnConnections: ["Rack"] })]), true);
  });

  test("a pair the table answers for will NOT, even with another connection to probe", () => {
    // THE GUARD, and the shape the export fixture does not have: a button that
    // drives a known module AND an unknown one. The table is verified and is
    // what the import offers as the default binding, so a pair told "will
    // learn" here would be told the wrong thing about itself.
    const inferred = {
      variable: "Plug:power_state",
      onValue: "On",
      offValue: "Off",
      moduleId: "x",
    };
    assert.equal(
      learnableOffer([half({ stateSource: inferred, learnConnections: ["Rack"] }), half()]),
      false,
    );
    // And on the OFF half: the offer reads the ON button's source with the OFF
    // one as a fallback, so either being answered is answered.
    assert.equal(
      learnableOffer([half({ learnConnections: ["Rack"] }), half({ stateSource: inferred })]),
      false,
    );
  });

  test("a pair with nothing to probe will not", () => {
    assert.equal(learnableOffer([half(), half()]), false);
    // A label the reference grammar refuses is nothing to probe.
    assert.equal(learnableOffer([half({ learnConnections: ["Old Thing"] }), half()]), false);
  });
});

describe("observing a press", () => {
  const candidates = ["Rack:state", "Rack:power"];

  test("binds a candidate that moved after ON and after OFF, to the two values", () => {
    const first = observePress(
      fresh,
      press("on", { "Rack:state": ["Standby", "Active"] }),
      candidates,
    );
    assert.equal(first.binding, null, "one direction is not a binding");
    const second = observePress(
      first.state,
      press("off", { "Rack:state": ["Active", "Standby"] }),
      candidates,
    );
    assert.deepEqual(second.binding, {
      variable: "Rack:state",
      onValue: "Active",
      offValue: "Standby",
    });
    assert.equal(second.state.stopped, "bound");
    assert.equal(second.state.attempts, 2);
  });

  test("binds whichever order the presses arrived in", () => {
    // An operator pressing OFF first is the ordinary case for a device that is
    // already on, and a feature that only learned on/off in that order would
    // learn nothing half the time.
    const first = observePress(
      fresh,
      press("off", { "Rack:state": ["Active", "Standby"] }),
      candidates,
    );
    const second = observePress(
      first.state,
      press("on", { "Rack:state": ["Standby", "Active"] }),
      candidates,
    );
    assert.deepEqual(second.binding, {
      variable: "Rack:state",
      onValue: "Active",
      offValue: "Standby",
    });
  });

  test("does NOT bind a candidate that moved after ON but not after OFF", () => {
    // THE GUARD. A variable that reacts to a press without reporting the state
    // — a `last_command`, a counter, a clock — moves once and then holds. Bound
    // from that, the switch reads on whatever the device is doing, which is the
    // optimism this whole feature exists to remove.
    const first = observePress(fresh, press("on", { "Rack:state": ["idle", "press"] }), candidates);
    const second = observePress(
      first.state,
      press("off", { "Rack:state": ["press", "press"] }),
      candidates,
    );
    assert.equal(second.binding, null);
    assert.deepEqual(second.state.observed["Rack:state"], { on: "press", values: ["press"] });
  });

  test("does NOT bind a candidate that took a third value", () => {
    // A projector's `status` reads Standby, Warming and Active. Bound on the
    // first two it reads unknown every time the device passes through the
    // third, which is exactly when somebody presses it again mid warm-up.
    const first = observePress(
      fresh,
      press("on", { "Rack:state": ["Standby", "Warming"] }),
      candidates,
    );
    const second = observePress(
      first.state,
      press("off", { "Rack:state": ["Warming", "Standby"] }),
      candidates,
    );
    const third = observePress(
      second.state,
      press("on", { "Rack:state": ["Standby", "Active"] }),
      candidates,
    );
    assert.equal(third.binding, null, "three values is not a two-state variable");
    assert.deepEqual(third.state.observed["Rack:state"]?.values, ["Warming", "Standby", "Active"]);
  });

  test("does NOT bind a candidate whose two directions read the same value", () => {
    // Both directions moved it, to the same word — a variable that ticks rather
    // than reports. There is no on value to tell from an off value.
    const first = observePress(fresh, press("on", { "Rack:state": ["a", "b"] }), candidates);
    const second = observePress(
      first.state,
      press("off", { "Rack:state": ["a", "b"] }),
      candidates,
    );
    assert.equal(second.binding, null);
  });

  test("treats a candidate that could not be read as no evidence", () => {
    // An unreachable Companion mid-window must not make a moving candidate look
    // static, and must not make a static one look like it moved.
    const outcome = observePress(fresh, { want: "on", before: {}, after: {} }, candidates);
    assert.deepEqual(outcome.state.observed, {});
    assert.equal(outcome.state.attempts, 1, "the press is still spent");
  });

  test("prefers the power-named candidate when two qualify", () => {
    // Two variables that both track the device is the case where this could
    // pick wrong. A name is the only evidence available — both moved the same
    // way at the same moment.
    const first = observePress(
      fresh,
      press("on", { "Rack:state": ["off", "on"], "Rack:power": ["0", "1"] }),
      candidates,
    );
    const second = observePress(
      first.state,
      press("off", { "Rack:state": ["on", "off"], "Rack:power": ["1", "0"] }),
      candidates,
    );
    assert.equal(second.binding?.variable, "Rack:power");
    assert.deepEqual(second.runnersUp, ["Rack:state"], "the other one is named on the log line");
  });

  test("gives up after the third press and says so", () => {
    let state = fresh;
    for (let i = 0; i < LEARN_MAX_ATTEMPTS; i++) {
      const outcome = observePress(state, press("on", { "Rack:state": ["x", "x"] }), candidates);
      state = outcome.state;
      assert.equal(outcome.binding, null);
      assert.equal(outcome.gaveUp, i === LEARN_MAX_ATTEMPTS - 1, `press ${i + 1}`);
    }
    assert.equal(state.stopped, "gave-up");
    assert.match(
      gaveUpLog("projectors"),
      /^\[cues\] pair projectors: could not learn a state source after 3 presses; pick one on the rule$/,
    );
  });

  test("forgets a candidate that is no longer on the list", () => {
    // A re-probe found fewer names — the connection was reconfigured. The
    // observations for a name that no longer exists must not survive, or a
    // binding could be written for a variable Companion no longer has.
    const first = observePress(fresh, press("on", { "Rack:state": ["a", "b"] }), candidates);
    const second = observePress(first.state, press("off", { "Rack:power": ["1", "0"] }), [
      "Rack:power",
    ]);
    assert.deepEqual(Object.keys(second.state.observed), ["Rack:power"]);
    assert.equal(second.binding, null);
  });

  test("names the variable, the values and the press count on the learned line", () => {
    assert.equal(
      learnedLog("projectors", { variable: "Rack:power", onValue: "On", offValue: "Off" }, 2, []),
      "[cues] pair projectors: learned state source Rack:power (On/Off) from watching 2 presses",
    );
    assert.match(
      learnedLog("p", { variable: "A:power", onValue: "1", offValue: "0" }, 3, ["A:state"]),
      /also matched A:state$/,
    );
  });
});

describe("picking between qualifying candidates", () => {
  test("power first, then status, then the order they were probed", () => {
    assert.equal(pickCandidate(["R:state", "R:power_status"]), "R:power_status");
    assert.equal(pickCandidate(["R:enabled", "R:record_status"]), "R:record_status");
    assert.equal(pickCandidate(["R:enabled", "R:active"]), "R:enabled");
  });

  test("reads the NAME, never the connection label", () => {
    // A connection somebody called "Power-Rack" is not evidence about which of
    // its variables reports the state.
    assert.equal(pickCandidate(["Power-Rack:active", "Other:power"]), "Other:power");
  });
});

describe("the stored form", () => {
  test("round-trips through the params", () => {
    const state: LearningState = {
      attempts: 1,
      observed: { "R:state": { on: "Active", values: ["Active"] } },
      probedAt: "2026-09-10T12:00:00.000Z",
    };
    const params = learningParams(["R:state", "R:power"], state);
    assert.equal(params.stateCandidates, "R:state,R:power");
    assert.deepEqual(parseCandidates(params), ["R:state", "R:power"]);
    assert.deepEqual(parseLearning(params), state);
  });

  test("survives a value containing a comma", () => {
    // THE GUARD for the encoding. A candidate's value is arbitrary text a
    // device chose; joined with commas like the names are, `Rec, paused` reads
    // back as two values and the binding is built from a value no variable ever
    // held.
    const state: LearningState = {
      attempts: 1,
      observed: { "R:state": { on: "Rec, paused", off: "Idle", values: ["Rec, paused", "Idle"] } },
    };
    assert.deepEqual(parseLearning(learningParams(["R:state"], state)), state);
  });

  test("reads a hand-mangled value as nothing learned rather than throwing", () => {
    assert.deepEqual(parseLearning({ stateLearning: "{not json" }), { attempts: 0, observed: {} });
    assert.deepEqual(parseLearning({ stateLearning: "[]" }), { attempts: 0, observed: {} });
    assert.deepEqual(parseLearning({}), { attempts: 0, observed: {} });
    assert.deepEqual(parseLearning({ stateLearning: '{"attempts":"lots","stopped":"maybe"}' }), {
      attempts: 0,
      observed: {},
    });
  });

  test("drops a candidate name Companion could not have", () => {
    assert.deepEqual(parseCandidates({ stateCandidates: "R:state,,has.a.dot:x, R:power " }), [
      "R:state",
      "R:power",
    ]);
  });

  test("writes both keys blank for learn again, so the next pass starts over", () => {
    // Every key written, blank for none, for the same reason
    // stateBindingParams writes all three: a key left out of a patch keeps its
    // old value, so "learn again" would keep the observations it is meant to
    // forget.
    assert.deepEqual(learnAgainParams(), { stateCandidates: "", stateLearning: "" });
    assert.deepEqual(parseLearning(learnAgainParams()).observed, {});
    assert.equal(parseLearning(learnAgainParams()).stopped, undefined);
  });
});

describe("whether to probe", () => {
  const hour = 60 * 60 * 1000;
  const at = (state: Partial<LearningState>) =>
    learningParams([], { attempts: 0, observed: {}, ...state });

  test("probes a pair nothing is known about", () => {
    assert.equal(shouldProbe({}, 1_000_000, hour), true);
  });

  test("does not probe again inside the hour", () => {
    const params = at({ probedAt: new Date(1_000_000).toISOString() });
    assert.equal(shouldProbe(params, 1_000_000 + hour - 1, hour), false);
    assert.equal(shouldProbe(params, 1_000_000 + hour, hour), true);
  });

  test("never probes a pair that bound or gave up", () => {
    // THE GUARD for a cleared binding. An operator who unbound a learned pair
    // on purpose must not have it re-probed and re-bound within the hour; only
    // "learn again" restarts it.
    assert.equal(shouldProbe(at({ stopped: "bound" }), 9e12, hour), false);
    assert.equal(shouldProbe(at({ stopped: "gave-up" }), 9e12, hour), false);
    assert.equal(shouldProbe(learnAgainParams(), 9e12, hour), true, "learn again restarts it");
  });

  test("probes when the timestamp is unreadable", () => {
    // A hand-edited or corrupted value. "Never probe again" is the wrong way to
    // fail: the whole feature would be off with nothing saying so.
    assert.equal(shouldProbe(at({ probedAt: "the other day" }), 1_000, hour), true);
  });
});

describe("what the editor says", () => {
  test("counts the candidates and says what to do", () => {
    assert.equal(
      learningHint(["R:state", "R:power"]),
      "Learning: watching 2 candidates; press the pair on and off once to bind",
    );
    assert.equal(
      learningHint(["R:state"]),
      "Learning: watching 1 candidate; press the pair on and off once to bind",
    );
  });
});
