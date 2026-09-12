// The rules-list search has to work as a substring match across six different
// fields, not just the rule's own name — a maintainer with a lot of cues is
// far more likely to remember what they SAY to a cue, or what button it
// presses, than the slug it got imported under. Each field gets its own guard
// so a future edit that reads one field but not another shows up here instead
// of just narrowing what the search box finds.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { encodeAliases } from "@main/services/cue-aliases";

import { labelFor, ruleMatchesSearch } from "./rule-search.js";

const CALL_TRIGGER_ID = "call.by-name";

function cue(over: Partial<{ name: string; params: Record<string, string | number>; actionId: string; actionParams: Record<string, string | number> }> = {}) {
  return {
    name: over.name ?? "Projectors ON",
    trigger: { id: CALL_TRIGGER_ID, params: over.params ?? { name: "projectors_on", says: "the projectors" } },
    action: { id: over.actionId ?? "log.message", params: over.actionParams ?? {} },
  };
}

describe("ruleMatchesSearch", () => {
  test("matches the rule's own name, case-insensitively", () => {
    assert.equal(ruleMatchesSearch(cue({ name: "House Lights" }), "house", undefined, undefined), true);
    assert.equal(ruleMatchesSearch(cue({ name: "House Lights" }), "HOUSE", undefined, undefined), true);
    assert.equal(ruleMatchesSearch(cue({ name: "House Lights" }), "lobby", undefined, undefined), false);
  });

  test("matches the cue name (trigger.params.name)", () => {
    const rule = cue({ params: { name: "lobby_screens_on", says: "the lobby screens" } });
    assert.equal(ruleMatchesSearch(rule, "lobby_screens", undefined, undefined), true);
  });

  test("matches 'says'", () => {
    const rule = cue({ params: { name: "x", says: "the foyer televisions" } });
    assert.equal(ruleMatchesSearch(rule, "foyer", undefined, undefined), true);
  });

  test("matches a former name (aliases)", () => {
    const rule = cue({ params: { name: "projectors_on", aliases: encodeAliases(["screens_on", "big_screens"]) } });
    assert.equal(ruleMatchesSearch(rule, "big_screens", undefined, undefined), true);
  });

  test("matches a Companion button's label on a companion.press action", () => {
    const rule = cue({ actionId: "companion.press", actionParams: { label: "Stage Left Spot" } });
    assert.equal(ruleMatchesSearch(rule, "stage left", undefined, undefined), true);
  });

  test("does NOT read a button label off a non-companion.press action", () => {
    const rule = cue({ actionId: "log.message", actionParams: { label: "Stage Left Spot", message: "x" } });
    assert.equal(ruleMatchesSearch(rule, "stage left", undefined, undefined), false);
  });

  test("matches the trigger's human label", () => {
    const rule = cue();
    assert.equal(ruleMatchesSearch(rule, "called by name", "Called by name (voice or HTTP)", undefined), true);
  });

  test("matches the action's human label", () => {
    const rule = cue();
    assert.equal(ruleMatchesSearch(rule, "press a companion", undefined, "Press a Companion button"), true);
  });

  test("an empty or blank query matches everything", () => {
    const rule = cue();
    assert.equal(ruleMatchesSearch(rule, "", undefined, undefined), true);
    assert.equal(ruleMatchesSearch(rule, "   ", undefined, undefined), true);
  });
});

describe("labelFor", () => {
  test("returns the matching spec's label", () => {
    assert.equal(labelFor([{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], "b"), "Beta");
  });

  test("returns undefined for an id not in the list", () => {
    assert.equal(labelFor([{ id: "a", label: "Alpha" }], "z"), undefined);
  });
});
