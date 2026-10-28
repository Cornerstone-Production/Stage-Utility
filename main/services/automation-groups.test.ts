// The pickers' headings, against the REAL registries.
//
// Every list here is computed from AUTOMATION_TRIGGERS / AUTOMATION_ACTIONS /
// AUTOMATION_CONDITIONS and compared with an exact empty array, so a failure
// names the definitions, not a count that moved.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ACTION_GROUPS,
  ACTION_PREFIX_GROUPS,
  CONDITION_GROUPS,
  OTHER_GROUP,
  TRIGGER_CHANNEL_GROUPS,
  TRIGGER_GROUPS,
  actionGroup,
  conditionGroup,
  triggerGroup,
} from "./automation-groups.js";
import { AUTOMATION_ACTIONS } from "./automation-actions.js";
import { AUTOMATION_CONDITIONS } from "./automation-conditions.js";
import { AUTOMATION_TRIGGERS } from "./automation-triggers.js";

const triggers = Object.values(AUTOMATION_TRIGGERS);
const actions = Object.values(AUTOMATION_ACTIONS);
const conditions = Object.values(AUTOMATION_CONDITIONS);

describe("every definition lands in a group", () => {
  test("triggers", () => {
    const ungrouped = triggers.filter((t) => triggerGroup(t.channel) === null).map((t) => `${t.channel}  ${t.id}`).sort();
    assert.deepEqual(ungrouped, [], "a trigger on a channel with no heading would fall under Other");
  });

  test("actions", () => {
    const ungrouped = actions.filter((a) => actionGroup(a.id) === null).map((a) => a.id).sort();
    assert.deepEqual(ungrouped, [], "an action with no heading would fall under Other");
  });

  test("conditions", () => {
    const ungrouped = conditions.filter((c) => conditionGroup(c.id) === null).map((c) => c.id).sort();
    assert.deepEqual(ungrouped, [], "a condition with no heading would fall under Other");
  });
});

describe("the maps hold nothing the registries do not use", () => {
  test("every mapped trigger channel has a trigger on it", () => {
    const used = new Set(triggers.map((t) => t.channel));
    const stale = Object.keys(TRIGGER_CHANNEL_GROUPS).filter((c) => !used.has(c)).sort();
    assert.deepEqual(stale, []);
  });

  test("every mapped action prefix has an action under it", () => {
    const used = new Set(actions.map((a) => a.id.split(".")[0]));
    const stale = Object.keys(ACTION_PREFIX_GROUPS).filter((p) => !used.has(p)).sort();
    assert.deepEqual(stale, []);
  });

  test("every heading has something under it, and every mapped heading is a listed one", () => {
    const heading = (xs: readonly string[], seen: (string | null)[]) => xs.filter((g) => !seen.includes(g)).sort();
    assert.deepEqual(heading(TRIGGER_GROUPS, triggers.map((t) => triggerGroup(t.channel))), [], "empty trigger headings");
    assert.deepEqual(heading(ACTION_GROUPS, actions.map((a) => actionGroup(a.id))), [], "empty action headings");
    assert.deepEqual(heading(CONDITION_GROUPS, conditions.map((c) => conditionGroup(c.id))), [], "empty condition headings");
    const listed = new Set<string>([...TRIGGER_GROUPS, ...ACTION_GROUPS, ...CONDITION_GROUPS, OTHER_GROUP]);
    const strays = [
      ...Object.values(TRIGGER_CHANNEL_GROUPS),
      ...Object.values(ACTION_PREFIX_GROUPS),
    ].filter((g) => !listed.has(g));
    assert.deepEqual(strays, []);
  });
});

describe("every definition says what it does in one line", () => {
  const lacking = (defs: { id: string; help?: string }[]) =>
    defs.filter((d) => !d.help || d.help.trim() === "" || d.help.includes("\n")).map((d) => d.id).sort();

  test("triggers", () => assert.deepEqual(lacking(triggers), []));
  test("actions", () => assert.deepEqual(lacking(actions), []));
  test("conditions", () => assert.deepEqual(lacking(conditions), []));
});

describe("a name nothing claims is not grouped", () => {
  test("null, so the picker can say Other rather than drop it", () => {
    assert.equal(triggerGroup("no:such-channel"), null);
    assert.equal(actionGroup("nothing.here"), null);
    assert.equal(conditionGroup("nothing.here"), null);
    // Prototype names are not headings.
    assert.equal(triggerGroup("constructor"), null);
    assert.equal(actionGroup("constructor.x"), null);
  });

  test("a seventeenth integration's is-connected is grouped by its suffix", () => {
    assert.equal(conditionGroup("brandnew.is-connected"), "Connections");
  });
});
