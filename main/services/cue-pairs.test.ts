// Which cues are two halves of one thing, and what reads its state.
//
// Pure functions over rules, and the guards here are all about the two ways a
// pair goes wrong silently:
//
//  - a pair that stops being a pair. One half of a Companion pair relabelled
//    renames its cue and keeps the old name as an alias, which leaves
//    `screens_on` beside `projectors_off`. Matched on current names only, that
//    is not a pair at all: the Home Assistant switch somebody already pasted
//    disappears from the generated config and turns into two scripts, and
//    nothing anywhere says why.
//  - a binding that can never read anything. A variable name Companion could not
//    have answers 404 forever, and on/off values that are the same string make a
//    switch that says "on" whatever the projector is doing. Both look like a
//    saved setting from the operator's side.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  boundCuePairs,
  cuePairs,
  defaultStateVariable,
  isTogglePair,
  stateBindingOf,
  stateBindingParams,
  stateBindingProblem,
  STATE_OFF_DEFAULT,
  STATE_ON_DEFAULT,
} from "./cue-pairs.js";
import { CALL_TRIGGER_ID } from "./automation-triggers.js";
import type { Rule } from "../types/automation.js";

/** One called cue, with only the fields these functions read set meaningfully. */
function cue(name: string, params: Record<string, string | number> = {}): Rule {
  return {
    id: `id-${name}`,
    name,
    enabled: true,
    trigger: { id: CALL_TRIGGER_ID, params: { name, ...params } },
    conditions: [],
    action: { id: "log.message", params: { message: "x" } },
    cooldownSec: 0,
    oncePerService: false,
  };
}

/** A rule that is not a cue at all. */
const timed: Rule = {
  id: "id-timed",
  name: "Ten minutes before",
  enabled: true,
  trigger: { id: "pco.item-due", params: { title: "Welcome" } },
  conditions: [],
  action: { id: "log.message", params: { message: "x" } },
  cooldownSec: 0,
  oncePerService: false,
};

/** The pairs as `<base>: <on>/<off>`, which is all a name-level assert needs. */
const shape = (rules: Rule[]): string[] =>
  cuePairs(rules).map((p) => `${p.base}: ${p.onName}/${p.offName}`);

describe("cuePairs", () => {
  test("an _on and its _off are one pair, and nothing else is", () => {
    const rules = [
      cue("projectors_on"),
      cue("projectors_off"),
      cue("house_lights_on"),
      cue("take_screens"),
      timed,
    ];
    assert.deepEqual(shape(rules), ["projectors: projectors_on/projectors_off"]);
  });

  test("pairs come back sorted by base, whatever order the rules are in", () => {
    const rules = [cue("screens_off"), cue("amps_on"), cue("screens_on"), cue("amps_off")];
    assert.deepEqual(shape(rules), ["amps: amps_on/amps_off", "screens: screens_on/screens_off"]);
  });

  test("a HALF-RENAMED pair is still a pair, under the base already pasted", () => {
    // The Companion ON button was relabelled and its cue renamed; the OFF button
    // was not touched. Nothing pairs by current name. The base is the FORMER one
    // because that is the switch id in the Home Assistant config somebody has
    // already got, and the whole point of keeping former names is that it keeps
    // working until they re-paste.
    const rules = [cue("screens_on", { aliases: "projectors_on" }), cue("projectors_off")];
    assert.deepEqual(shape(rules), ["projectors: screens_on/projectors_off"]);
    assert.deepEqual(cuePairs(rules).map((p) => p.viaFormerName), [true]);
  });

  test("the _off half may be the one carrying the former name", () => {
    const rules = [cue("projectors_on"), cue("screens_off", { aliases: "projectors_off" })];
    assert.deepEqual(shape(rules), ["projectors: projectors_on/screens_off"]);
  });

  test("a pair that matches by name is NOT reported as found through an alias", () => {
    const rules = [
      cue("projectors_on", { aliases: "beamers_on" }),
      cue("projectors_off", { aliases: "beamers_off" }),
    ];
    assert.deepEqual(shape(rules), ["projectors: projectors_on/projectors_off"]);
    assert.deepEqual(cuePairs(rules).map((p) => p.viaFormerName), [false]);
  });

  test("a current name beats a former one when both could pair", () => {
    // `screens_on`/`screens_off` are both live names; `screens_on` also answers
    // to `projectors_on`, and a `projectors_off` exists. The live pair wins and
    // no cue ends up in two pairs — two switches sharing a turn_off would be an
    // assistant turning off a device the operator did not name.
    const rules = [
      cue("screens_on", { aliases: "projectors_on" }),
      cue("screens_off"),
      cue("projectors_off"),
    ];
    assert.deepEqual(shape(rules), ["screens: screens_on/screens_off"]);
  });

  test("an _on with no _off is not a pair, and neither is a lone _off", () => {
    assert.deepEqual(shape([cue("house_lights_on")]), []);
    assert.deepEqual(shape([cue("house_lights_off")]), []);
    // `_on` on its own with nothing before it is not a base.
    assert.deepEqual(shape([cue("_on"), cue("_off")]), []);
  });

  test("a duplicate cue name is read first-wins, not twice", () => {
    // The engine refuses duplicates; a hand-built list or a restored file may
    // still hold one, and the generated config reads the first.
    const rules = [cue("projectors_on"), cue("projectors_on"), cue("projectors_off")];
    assert.equal(cuePairs(rules).length, 1);
    assert.equal(cuePairs(rules)[0]!.on.id, "id-projectors_on");
  });

  test("a rule that is not a called cue is invisible here", () => {
    assert.deepEqual(shape([timed]), []);
  });
});

describe("a pair's state binding", () => {
  const bound = () => [
    cue("projectors_on", { stateVariable: "projectors_state" }),
    cue("projectors_off"),
  ];

  test("the _on half carries it and the _off half inherits it", () => {
    const pairs = cuePairs(bound());
    assert.deepEqual(pairs[0]!.binding, {
      variable: "projectors_state",
      onValue: STATE_ON_DEFAULT,
      offValue: STATE_OFF_DEFAULT,
    });
  });

  test("on and off values override the defaults", () => {
    const pairs = cuePairs([
      cue("projectors_on", { stateVariable: "p", stateOnValue: "POWER=ON", stateOffValue: "STANDBY" }),
      cue("projectors_off"),
    ]);
    assert.deepEqual(pairs[0]!.binding, {
      variable: "p",
      onValue: "POWER=ON",
      offValue: "STANDBY",
    });
  });

  test("a binding hand-written on the _off half is honoured, not silently ignored", () => {
    // The editor only offers it on the `_on` half. A rules file edited by hand
    // is otherwise a setting that saves and does nothing.
    const pairs = cuePairs([cue("projectors_on"), cue("projectors_off", { stateVariable: "p_state" })]);
    assert.equal(pairs[0]!.binding?.variable, "p_state");
  });

  test("a blank stateVariable is NO binding, not a binding to nothing", () => {
    // Clearing the select writes the key with an empty value rather than
    // deleting it. Read as a binding, every such pair would be unknown forever.
    const pairs = cuePairs([
      cue("projectors_on", { stateVariable: "", stateOnValue: "on" }),
      cue("projectors_off"),
    ]);
    assert.equal(pairs[0]!.binding, null);
    assert.equal(stateBindingOf({ stateVariable: "   " }), null);
  });

  test("boundCuePairs is the bound ones and only those", () => {
    const rules = [...bound(), cue("amps_on"), cue("amps_off")];
    assert.deepEqual(cuePairs(rules).map((p) => p.base), ["amps", "projectors"]);
    assert.deepEqual(boundCuePairs(rules).map((p) => p.base), ["projectors"]);
  });

  test("the stored form writes every key, so clearing one saves", () => {
    assert.deepEqual(stateBindingParams({ variable: "p_state" }), {
      stateVariable: "p_state",
      stateOnValue: "",
      stateOffValue: "",
    });
    assert.deepEqual(stateBindingParams(null), {
      stateVariable: "",
      stateOnValue: "",
      stateOffValue: "",
    });
  });
});

describe("stateBindingProblem", () => {
  test("no binding is no problem", () => {
    assert.equal(stateBindingProblem({}), null);
    assert.equal(stateBindingProblem({ stateVariable: "" }), null);
    assert.equal(stateBindingProblem({ stateVariable: "projectors_state" }), null);
  });

  test("a module variable is a binding too", () => {
    // `<connection label>:<name>` is what Companion answers for at
    // /api/variable/<label>/<name>/value. A pair bound to a kasa plug's own
    // power_state needs no operator-maintained custom variable at all.
    assert.equal(stateBindingProblem({ stateVariable: "VCR-Overhead-Light:power_state" }), null);
    assert.equal(stateBindingProblem({ stateVariable: "custom:projectors_state" }), null);
  });

  test("a name Companion could not have is refused", () => {
    const why = stateBindingProblem({ stateVariable: "../../x" });
    assert.equal(typeof why, "string");
    assert.match(String(why), /not a Companion variable/);
    // A dot is legal in a variable name and not in a connection label, so this
    // is neither half of anything Companion could answer for.
    assert.match(String(stateBindingProblem({ stateVariable: "VCR.Light:power" })), /not a Companion/);
  });

  test("on and off values that are the same string are refused", () => {
    // A switch that reads "on" whatever the projector is doing is worse than an
    // optimistic one, because it looks like it knows.
    const why = stateBindingProblem({
      stateVariable: "p",
      stateOnValue: "1",
      stateOffValue: "1",
    });
    assert.match(String(why), /could never be read/);
    // The defaults differ, so an unset pair of values is fine.
    assert.equal(stateBindingProblem({ stateVariable: "p" }), null);
  });

  test('"*" is accepted as the OFF value and refused as the on value', () => {
    assert.equal(
      stateBindingProblem({ stateVariable: "Deck:status", stateOnValue: "Record", stateOffValue: "*" }),
      null,
    );
    // On `*` is a switch that reads on whatever the device is doing — the exact
    // silent failure the binding exists to remove.
    assert.match(
      String(stateBindingProblem({ stateVariable: "Deck:status", stateOnValue: "*", stateOffValue: "x" })),
      /can only be the off value/,
    );
    // Both `*` is reported as the on value being wrong, not as the two matching:
    // moving it to the off field is the fix, and "they are the same" does not
    // say that.
    assert.match(
      String(stateBindingProblem({ stateVariable: "Deck:status", stateOnValue: "*", stateOffValue: "*" })),
      /can only be the off value/,
    );
  });
});

describe("defaultStateVariable", () => {
  const NAMES = ["house_lights_state", "lobby_tvs", "projectors_last_error", "rig.state"];

  test("<base> and <base>_state match, and nothing looser does", () => {
    assert.equal(defaultStateVariable("lobby_tvs", NAMES), "lobby_tvs");
    assert.equal(defaultStateVariable("house_lights", NAMES), "house_lights_state");
    // `projectors_last_error` CONTAINS the slug. Binding to it would report the
    // wrong thing with nobody having chosen it.
    assert.equal(defaultStateVariable("projectors", NAMES), "");
  });

  test("the match is case-insensitive and the real spelling comes back", () => {
    assert.equal(defaultStateVariable("lobby_tvs", ["Lobby_TVs"]), "Lobby_TVs");
  });

  test("nothing matching is \"\", and an empty slug matches nothing", () => {
    assert.equal(defaultStateVariable("amps", NAMES), "");
    assert.equal(defaultStateVariable("", NAMES), "");
    assert.equal(defaultStateVariable("", ["_state"]), "");
  });
});

describe("isTogglePair", () => {
  /** A cue that presses a Companion button at these coordinates. */
  const press = (name: string, at: { page: number; row: number; col: number }): Rule => ({
    ...cue(name),
    action: { id: "companion.press", params: { ...at } },
  });
  const SAME = { page: 1, row: 2, col: 1 };

  const only = (rules: Rule[]) => cuePairs(rules)[0]!;

  test("both halves on one button is a toggle", () => {
    assert.equal(isTogglePair(only([press("lights_on", SAME), press("lights_off", SAME)])), true);
  });

  test("two different buttons is not", () => {
    assert.equal(
      isTogglePair(only([press("lights_on", SAME), press("lights_off", { ...SAME, col: 2 })])),
      false,
    );
  });

  test("coordinates only — a stale fingerprint on one half must not hide it", () => {
    // A reconcile updates one half's label and action ids before the other's,
    // and a comparison that included them would read a toggle as an ordinary
    // pair for as long as that lasted — which is the window in which the
    // generated config would stop warning about it.
    const on = press("lights_on", SAME);
    on.action.params.label = "House Lights ON";
    on.action.params.actionIds = "a1,a2";
    assert.equal(isTogglePair(only([on, press("lights_off", SAME)])), true);
  });

  test("a pair that presses nothing is not a toggle", () => {
    // Two `log.message` cues share no button, so there is nothing for a state
    // variable to disambiguate and nothing to warn about.
    assert.equal(isTogglePair(only([cue("lights_on"), cue("lights_off")])), false);
  });

  test("coordinates that are not numbers are not a match", () => {
    // A hand-edited rules file with `page: "one"` must not compare equal to
    // another one just because both are unusable.
    const on = press("lights_on", SAME);
    on.action.params.page = "one";
    const off = press("lights_off", SAME);
    off.action.params.page = "one";
    assert.equal(isTogglePair(only([on, off])), false);
  });
});

// ── State from Stage Utility itself ───────────────────────────────────────────
//
// A cue that drives REAPER directly presses no Companion button, so there is no
// Companion variable to bind — and an optimistic Record/Stop pair would report
// "recording" after a Record that REAPER never carried out. The pair is bound to
// `app:reaper.recording` without anybody choosing it.

describe("app: state sources", () => {
  /** A cue with a `reaper.transport` action. */
  const transport = (name: string, command: string, params: Record<string, string> = {}): Rule => ({
    ...cue(name, params),
    action: { id: "reaper.transport", params: { command } },
  });

  const recordPair = (params: Record<string, string> = {}): Rule[] => [
    transport("reaper_record_on", "record", params),
    transport("reaper_record_off", "stop"),
  ];

  test("a Record/Stop pair is bound with nothing configured", () => {
    const pair = cuePairs(recordPair())[0]!;
    assert.deepEqual(pair.binding, {
      variable: "app:reaper.recording",
      onValue: "on",
      offValue: "off",
    });
    assert.equal(boundCuePairs(recordPair()).length, 1);
  });

  test("an explicit state variable on the rule wins", () => {
    const pair = cuePairs(recordPair({ stateVariable: "rec_state" }))[0]!;
    assert.equal(pair.binding?.variable, "rec_state");
  });

  test("a Play/Stop pair implies nothing — only Record has an answer to read", () => {
    const pair = cuePairs([
      transport("reaper_play_on", "play"),
      transport("reaper_play_off", "stop"),
    ])[0]!;
    assert.equal(pair.binding, null);
  });

  test("a pair pressing Companion buttons is unaffected", () => {
    assert.equal(cuePairs([cue("lights_on"), cue("lights_off")])[0]!.binding, null);
  });

  test("a known app source is a binding the server accepts", () => {
    assert.equal(stateBindingProblem({ stateVariable: "app:reaper.recording" }), null);
  });

  test("an app source nothing answers to is refused, and the known ones named", () => {
    // `app:reaper` is a typo whose only symptom would be a switch that never
    // reports anything, so it is a 400 at the moment it is typed.
    const problem = stateBindingProblem({ stateVariable: "app:reaper" });
    assert.match(String(problem), /not a Stage Utility state source/);
    assert.match(String(problem), /app:reaper\.recording/);
  });

  test("an app source is still refused values that could never be read", () => {
    assert.match(
      String(
        stateBindingProblem({
          stateVariable: "app:reaper.recording",
          stateOnValue: "yes",
          stateOffValue: "yes",
        }),
      ),
      /both "yes"/,
    );
  });
});
