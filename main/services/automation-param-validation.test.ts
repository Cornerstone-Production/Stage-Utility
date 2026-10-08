// Every validation rule proven both ways: the value it should refuse, and the
// value right at the edge that it must accept. Each `test` here is also a red
// proof — the commit that adds this file states, per rule, what reverting to
// the naive check (no `optional`, no `optionsFrom` exemption, etc.) turns red.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { ParamDef } from "../types/automation.js";
import {
  fieldsNeedAttention,
  numberParamDefault,
  ruleIssues,
  seedNumberDefaults,
  validateParams,
  type RuleStepsLike,
  type StepSpecLookup,
} from "./automation-param-validation.js";
import { AUTOMATION_CONDITIONS } from "./automation-conditions.js";
import { AUTOMATION_TRIGGERS } from "./automation-triggers.js";

describe("validateParams — string", () => {
  const spec: ParamDef = { key: "meter", label: "Meter", type: "string", help: 'The Smaart meter key, "device::channel".' };

  test("blank required string is an issue, with the spec's help appended", () => {
    assert.deepEqual(validateParams([spec], {}), [
      { key: "meter", message: 'Required — The Smaart meter key, "device::channel".' },
    ]);
  });

  test("whitespace-only counts as blank", () => {
    assert.deepEqual(validateParams([spec], { meter: "   " }), [
      { key: "meter", message: 'Required — The Smaart meter key, "device::channel".' },
    ]);
  });

  test("a required string with no help just says Required", () => {
    const noHelp: ParamDef = { key: "message", label: "Message", type: "string" };
    assert.deepEqual(validateParams([noHelp], { message: "" }), [{ key: "message", message: "Required" }]);
  });

  test("a filled string is never an issue", () => {
    assert.deepEqual(validateParams([spec], { meter: "carbonite::1" }), []);
  });

  test("an optional blank string is never an issue", () => {
    const optional: ParamDef = { key: "room", label: "Room", type: "string", optional: true };
    assert.deepEqual(validateParams([optional], {}), []);
  });
});

describe("validateParams — number", () => {
  const spec: ParamDef = { key: "threshold", label: "Threshold (dB)", type: "number", min: 0, max: 140 };

  test("a missing required number is an issue", () => {
    assert.deepEqual(validateParams([spec], {}), [{ key: "threshold", message: "Required" }]);
  });

  test("below the minimum names the range", () => {
    assert.deepEqual(validateParams([spec], { threshold: -1 }), [
      { key: "threshold", message: "Must be between 0 and 140" },
    ]);
  });

  test("above the maximum names the range", () => {
    assert.deepEqual(validateParams([spec], { threshold: 141 }), [
      { key: "threshold", message: "Must be between 0 and 140" },
    ]);
  });

  test("the boundary values are both fine", () => {
    assert.deepEqual(validateParams([spec], { threshold: 0 }), []);
    assert.deepEqual(validateParams([spec], { threshold: 140 }), []);
  });

  test("non-finite is 'Must be a number', not silently 0", () => {
    assert.deepEqual(validateParams([spec], { threshold: "not a number" }), [
      { key: "threshold", message: "Must be a number" },
    ]);
  });

  test("a missing OPTIONAL number resolves to min and is never an issue — this is the seeding-bug guard", () => {
    // osc.value's real "argument" param: optional, min 0. Before the seeding fix
    // this could sit unset in storage forever; it must never read as "needs setup".
    const optional: ParamDef = { key: "argument", label: "Argument", type: "number", min: 0, max: 7, optional: true };
    assert.deepEqual(validateParams([optional], {}), []);
  });

  test("an out-of-range value on an OPTIONAL number is still an issue", () => {
    const optional: ParamDef = { key: "argument", label: "Argument", type: "number", min: 0, max: 7, optional: true };
    assert.deepEqual(validateParams([optional], { argument: 9 }), [
      { key: "argument", message: "Must be between 0 and 7" },
    ]);
  });

  test("min-only and max-only word the range as 'at least'/'at most'", () => {
    assert.deepEqual(validateParams([{ key: "n", label: "N", type: "number", min: 5 }], { n: 1 }), [
      { key: "n", message: "Must be at least 5" },
    ]);
    assert.deepEqual(validateParams([{ key: "n", label: "N", type: "number", max: 5 }], { n: 9 }), [
      { key: "n", message: "Must be at most 5" },
    ]);
  });
});

describe("validateParams — enum", () => {
  const target: ParamDef = { key: "targetId", label: "Target", type: "enum", optionsFrom: "rosstalk-targets" };
  const anchor: ParamDef = {
    key: "anchor",
    label: "Relative to",
    type: "enum",
    options: [{ value: "item", label: "The item's own time" }, { value: "service-start", label: "The service start" }],
  };

  test("blank required enum is 'Pick a <label>'", () => {
    assert.deepEqual(validateParams([target], {}), [{ key: "targetId", message: "Pick a target" }]);
  });

  test("a runtime (optionsFrom) list answering without the stored value is NOT an issue", () => {
    // This is the exact case Main.dc.html shows as an amber note, not a red error:
    // the target list came back short (a machine is off), and the rule still saves.
    assert.deepEqual(validateParams([target], { targetId: "retired-target" }), []);
  });

  test("optionsFrom exempts the static-list check too, even if a spec somehow carried both", () => {
    // No ParamDef in the registry sets both today, but the exemption is written
    // as an explicit rule rather than a byproduct of `options` being unset — this
    // is what proves that, and what would go red if the `optionsFrom` check were
    // ever dropped in favour of relying on `options` alone being absent.
    const both: ParamDef = { ...target, options: [{ value: "stale", label: "Stale" }] };
    assert.deepEqual(validateParams([both], { targetId: "not-stale-either" }), []);
  });

  test("a static options list must contain the value", () => {
    assert.deepEqual(validateParams([anchor], { anchor: "not-a-real-anchor" }), [
      { key: "anchor", message: "Pick a relative to" },
    ]);
  });

  test("a value present in the static list is fine", () => {
    assert.deepEqual(validateParams([anchor], { anchor: "item" }), []);
  });

  test("an optional enum left blank is never an issue", () => {
    const optional: ParamDef = { ...target, optional: true };
    assert.deepEqual(validateParams([optional], {}), []);
  });
});

describe("validateParams — multi-enum follows `optional`", () => {
  const days: ParamDef = {
    key: "days",
    label: "Days",
    type: "multi-enum",
    options: ["Sun", "Mon", "Tue"].map((d, i) => ({ value: String(i), label: d })),
  };

  test("a blank multi-enum that is not optional needs setup", () => {
    assert.deepEqual(validateParams([days], {}), [{ key: "days", message: "Pick at least one" }]);
    assert.deepEqual(validateParams([days], { days: " , " }), [{ key: "days", message: "Pick at least one" }]);
  });

  test("a blank optional multi-enum is never an issue", () => {
    assert.deepEqual(validateParams([{ ...days, optional: true }], {}), []);
  });

  test("the two registry multi-enums that mean everything when blank are declared optional", () => {
    // time.day-of-week reads "" as every day and pco.before-plan-time reads it
    // as both kinds of time, on purpose. A rule using that default must not be
    // marked as needing setup, so they say so rather than relying on the
    // validator to exempt every multi-enum.
    assert.deepEqual(validateParams(AUTOMATION_CONDITIONS["time.day-of-week"]!.params, {}), []);
    assert.deepEqual(validateParams(AUTOMATION_TRIGGERS["pco.before-plan-time"]!.params, { minutes: 10 }), []);
  });

  test("a populated value must still be drawn from the static list", () => {
    assert.deepEqual(validateParams([days], { days: "0,9" }), [{ key: "days", message: "Pick a days" }]);
  });

  test("a populated, valid value is fine", () => {
    assert.deepEqual(validateParams([days], { days: "0,1" }), []);
  });

  test("an optionsFrom multi-enum is exempt from the static-list check the same way enum is", () => {
    const spec: ParamDef = { key: "x", label: "X", type: "multi-enum", optionsFrom: "displays" };
    assert.deepEqual(validateParams([spec], { x: "anything,at,all" }), []);
  });

  test("an exclusive choice cannot be saved beside another, and is fine alone", () => {
    const spec: ParamDef = {
      key: "to",
      label: "To",
      type: "multi-enum",
      optionsFrom: "displays",
      exclusiveChoice: { value: "all", message: "All cannot be combined" },
    };
    assert.deepEqual(validateParams([spec], { to: "all,x" }), [{ key: "to", message: "All cannot be combined" }]);
    assert.deepEqual(validateParams([spec], { to: "x , all" }), [{ key: "to", message: "All cannot be combined" }]);
    assert.deepEqual(validateParams([spec], { to: "all" }), []);
    assert.deepEqual(validateParams([spec], { to: "x,y" }), []);
  });
});

describe("validateParams — key-value", () => {
  const rows: ParamDef = {
    key: "rows",
    label: "Send for each slot",
    type: "key-value",
    keyLabel: "Slot",
    valueLabel: "Send exactly",
  };

  test("zero rows on a required key-value param is an issue", () => {
    assert.deepEqual(validateParams([rows], {}), [{ key: "rows", message: "Add at least one slot" }]);
    assert.deepEqual(validateParams([rows], { rows: "{}" }), [{ key: "rows", message: "Add at least one slot" }]);
  });

  test("at least one row is fine", () => {
    assert.deepEqual(validateParams([rows], { rows: JSON.stringify({ "1": "Pastor HH" }) }), []);
  });

  test("an optional key-value param with zero rows is never an issue", () => {
    assert.deepEqual(validateParams([{ ...rows, optional: true }], {}), []);
  });

  test("text that is not a JSON object is an issue, not a crash", () => {
    assert.deepEqual(validateParams([rows], { rows: "not json" }), [{ key: "rows", message: "This isn't a valid list" }]);
    assert.deepEqual(validateParams([rows], { rows: "[1,2]" }), [{ key: "rows", message: "This isn't a valid list" }]);
  });

  test("a blank key on an in-progress row is NOT checked here — see KeyValueField", () => {
    // The stored value can never carry a blank key: KeyValueField filters one out
    // before it ever reaches onChange. "Every row needs a slot name" is therefore
    // enforced live, against the field's own in-progress rows, not against
    // anything this pure function is ever handed.
    assert.deepEqual(validateParams([rows], { rows: JSON.stringify({ "": "Pastor HH" }) }), []);
  });
});

describe("numberParamDefault", () => {
  test("0, pulled up into a positive floor", () => {
    assert.equal(numberParamDefault({ min: 1, max: 999 }), 1);
  });

  test("0 itself, when it is already in range", () => {
    assert.equal(numberParamDefault({ min: 0, max: 99 }), 0);
  });

  test("no bound at all is 0", () => {
    assert.equal(numberParamDefault({}), 0);
  });

  // The real bug: a NEGATIVE floor must not come back as the floor itself.
  // offsetMinutes (min -720, max 720) is the one param in the whole registry
  // this differs for — see first-trigger.test.mts's registry dump in the
  // review scratchpad, which found no other negative min anywhere.
  test("a negative floor stays 0, not the floor — offsetMinutes' exact shape", () => {
    assert.equal(numberParamDefault({ min: -720, max: 720 }), 0);
  });

  test("a range that excludes 0 entirely clamps to whichever bound is closer", () => {
    assert.equal(numberParamDefault({ min: -50, max: -10 }), -10);
    assert.equal(numberParamDefault({ min: 5, max: 10 }), 5);
  });
});

describe("seedNumberDefaults", () => {
  test("seeds every number param to 0, clamped into its own range, and nothing else", () => {
    const specs: ParamDef[] = [
      { key: "page", label: "Page", type: "number", min: 1, max: 999 },
      { key: "row", label: "Row", type: "number", min: 0, max: 99 },
      { key: "offsetMinutes", label: "Offset (minutes)", type: "number", min: -720, max: 720 },
      { key: "label", label: "Label", type: "string", optional: true },
    ];
    // Reverting to the old `spec.min ?? 0` fallback turns this red:
    // offsetMinutes would come back -720 instead of 0.
    assert.deepEqual(seedNumberDefaults(specs), { page: 1, row: 0, offsetMinutes: 0 });
  });

  test("a number with no min seeds to 0", () => {
    assert.deepEqual(seedNumberDefaults([{ key: "n", label: "N", type: "number" }]), { n: 0 });
  });
});

// A fresh pick of the real "Plan item is due" trigger, left at its
// default offset. AUTOMATION_TRIGGERS is automation-triggers.ts's real
// registry (read-only here, not modified) — this proves the fix against the
// actual param spec, not a stand-in with a friendlier min.
describe("seedNumberDefaults against the real registry — pco.item-due", () => {
  test("offsetMinutes seeds to 0, not its -720 floor", () => {
    const t = AUTOMATION_TRIGGERS["pco.item-due"];
    assert.deepEqual(seedNumberDefaults(t.params).offsetMinutes, 0);
  });

  test("a fresh pick fires at the item's own time, not 12 hours early", () => {
    const t = AUTOMATION_TRIGGERS["pco.item-due"];
    // What seededParams actually seeds, plus what the operator types: the two
    // non-number fields (see rule-editor-dialog.tsx's ParamField for the
    // number branch, and inspector.tsx's RossTalk equivalent — both number
    // branches share this same seed).
    const seeded = seedNumberDefaults(t.params);
    const params = { ...seeded, title: "doors", anchor: "item" };
    assert.deepEqual(validateParams(t.params, params), [], "the seeded params must validate clean");

    const NOW = Date.parse("2026-09-27T14:00:00Z");
    const DOORS = NOW + 300_000;
    const live = (ms: number) => ({
      mode: "item", currentItemId: "i1", label: null, lengthSec: 300,
      liveStartAt: null, targetAt: null, serverNow: new Date(ms).toISOString(),
      currentItemTitle: "Welcome", nextItemTitle: null,
      serviceTimeId: "st1", serviceTimeStartsAt: new Date(NOW + 600_000).toISOString(),
      itemSchedule: [{ title: "Doors Open", dueAt: new Date(DOORS).toISOString(), exact: true }],
    });
    // Reverting seedNumberDefaults to `spec.min ?? 0` turns this red: stored
    // offsetMinutes=-720 puts the due moment 12 hours before either snapshot,
    // so it never lands in the window and this never fires.
    const fired = t.didFire(live(DOORS - 30_000), live(DOORS + 30_000), params, NOW);
    assert.equal(fired, true, `did not fire at the item's time; stored offsetMinutes=${seeded.offsetMinutes}`);
  });
});

describe("fieldsNeedAttention", () => {
  test("singular vs plural", () => {
    assert.equal(fieldsNeedAttention(1), "1 field needs attention");
    assert.equal(fieldsNeedAttention(4), "4 fields need attention");
    assert.equal(fieldsNeedAttention(0), "0 fields need attention");
  });
});

describe("ruleIssues", () => {
  const lookup: StepSpecLookup = (kind, id) => {
    if (kind === "trigger" && id === "spl.above") {
      return {
        label: "SPL rises above",
        params: [
          { key: "meter", label: "Meter", type: "string", help: "device::channel" },
          { key: "threshold", label: "Threshold (dB)", type: "number", min: 0, max: 140 },
        ],
      };
    }
    if (kind === "condition" && id === "service.is-not-live") {
      return { label: "Not during a service", params: [] };
    }
    if (kind === "condition" && id === "baptism.phase-is") {
      return {
        label: "Baptism phase is",
        params: [{ key: "phase", label: "Phase", type: "enum", options: [{ value: "idle", label: "Idle" }] }],
      };
    }
    if (kind === "action" && id === "rosstalk.command") {
      return {
        label: "Send a RossTalk command",
        params: [
          { key: "targetId", label: "Target", type: "enum", optionsFrom: "rosstalk-targets" },
          { key: "commandId", label: "Command", type: "enum", optionsFrom: "rosstalk-commands" },
        ],
      };
    }
    return null;
  };

  const rule = (over: Partial<RuleStepsLike> = {}): RuleStepsLike => ({
    trigger: { id: "spl.above", params: { meter: "", threshold: 95 } },
    conditions: [],
    action: { id: "rosstalk.command", params: { targetId: "", commandId: "cut" } },
    ...over,
  });

  test("collects issues across trigger and action, unprefixed (a rule has exactly one of each)", () => {
    assert.deepEqual(ruleIssues(rule(), lookup), [
      { step: "trigger", key: "meter", label: "Meter", message: "Required — device::channel" },
      { step: "action", key: "targetId", label: "Target", message: "Pick a target" },
    ]);
  });

  test("a single condition's field is not prefixed with the condition's label", () => {
    const r = rule({ conditions: [{ id: "baptism.phase-is", params: {} }] });
    const issues = ruleIssues(r, lookup).filter((i) => i.step === "condition");
    assert.deepEqual(issues, [{ step: "condition", index: 0, key: "phase", label: "Phase", message: "Pick a phase" }]);
  });

  test("two or more conditions get their label prefixed to disambiguate", () => {
    const r = rule({
      conditions: [
        { id: "service.is-not-live", params: {} },
        { id: "baptism.phase-is", params: {} },
      ],
    });
    const issues = ruleIssues(r, lookup).filter((i) => i.step === "condition");
    assert.deepEqual(issues, [
      { step: "condition", index: 1, key: "phase", label: "Baptism phase is · Phase", message: "Pick a phase" },
    ]);
  });

  test("a step id the registry no longer has is skipped, not flagged", () => {
    const r = rule({ trigger: { id: "obs.retired-trigger", params: {} } });
    assert.deepEqual(
      ruleIssues(r, lookup).filter((i) => i.step === "trigger"),
      [],
    );
  });

  test("a clean rule has no issues at all", () => {
    const r = rule({
      trigger: { id: "spl.above", params: { meter: "carbonite::1", threshold: 95 } },
      action: { id: "rosstalk.command", params: { targetId: "carbonite", commandId: "cut" } },
    });
    assert.deepEqual(ruleIssues(r, lookup), []);
  });
});

// The validator side of the companion.press seeding bug: validateParams itself
// was always correct — page/row/col unset is "Required" like any other
// missing required number. The bug was that the RENDERER seeded page to 1
// before a button was ever chosen, so validateParams was never asked about an
// empty page at all. See rule-editor-dialog.tsx's hasCustomParamsPicker.
describe("validateParams — companion.press's real shape, unpicked", () => {
  const specs: ParamDef[] = [
    { key: "page", label: "Page", type: "number", min: 1, max: 999 },
    { key: "row", label: "Row", type: "number", min: 0, max: 99 },
    { key: "col", label: "Column", type: "number", min: 0, max: 99 },
  ];

  test("no button chosen (params: {}) is three issues, not zero", () => {
    assert.deepEqual(validateParams(specs, {}), [
      { key: "page", message: "Required" },
      { key: "row", message: "Required" },
      { key: "col", message: "Required" },
    ]);
  });

  test("seeded to the min of each (the bug's exact symptom) reads as fully valid", () => {
    // This is the point of hasCustomParamsPicker: validateParams cannot tell
    // "1/0/0 because nothing is chosen yet" from "1/0/0, a real button" — the
    // two look identical to it, on purpose (a real p1 r0 c0 must validate
    // clean). The fix is that companion.press is never handed these values
    // until an operator actually picks a button, not a change here.
    assert.deepEqual(validateParams(specs, { page: 1, row: 0, col: 0 }), []);
  });
});
