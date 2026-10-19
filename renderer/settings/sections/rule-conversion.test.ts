// Converting a rule between manual and automatic, as pure functions.
//
// The editor's drafts go through these; what is guarded is what a conversion must
// never do: rename a cue Home Assistant has an entity for, lose the rule's own
// fields, or ask Home Assistant a question it need not.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Rule } from "@main/types/automation";

import { homeEntity, homeImpact, impactQuestion, makeAutomatic, makeManual } from "./rule-conversion.js";

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "r1",
  name: "Projectors",
  enabled: true,
  trigger: { id: "pco.service-started", params: {} },
  conditions: [{ id: "service.type-is", params: { serviceTypeId: "7" } }],
  action: { id: "log.message", params: { message: "x" } },
  cooldownSec: 30,
  oncePerService: true,
  ...over,
});
const cue = (params: Record<string, string | number> = {}, over: Partial<Rule> = {}): Rule =>
  rule({ trigger: { id: "call.by-name", params: { name: "projectors", ...params } }, cooldownSec: 2, ...over });

const none = new Set<string>();

describe("makeAutomatic", () => {
  test("keeps everything but the trigger, which is empty until the operator picks one", () => {
    const r = cue({ says: "the projectors", aliases: "old" }, { enabled: false });
    const a = makeAutomatic(r, r);
    assert.deepEqual(a.trigger, { id: "", params: {} });
    assert.deepEqual({ ...a, trigger: r.trigger }, r);
  });
});

describe("round trips", () => {
  test("an automatic rule made manual and automatic again has its own trigger back, not a blank", () => {
    const seed = rule();
    const back = makeAutomatic(makeManual(seed, seed, none), seed);
    assert.deepEqual(back.trigger, seed.trigger);
  });

  test("Ask twice is cleared going automatic, where nothing can clear it, and restored coming back", () => {
    const seed = cue({}, { confirmRequired: true });
    const auto = makeAutomatic(seed, seed);
    assert.equal(auto.confirmRequired, false);
    assert.equal(makeManual(auto, seed, none).confirmRequired, true);
    assert.equal(makeAutomatic(cue(), cue()).confirmRequired, undefined, "a rule that never had it is not given it");
  });
});

describe("makeManual", () => {
  test("from an automatic rule: Called by name, a cue name from the rule's name, Home Assistant OFF; the rest kept", () => {
    const r = rule({ name: "Stage reset", enabled: false });
    const m = makeManual(r, r, none);
    assert.deepEqual(m.trigger, { id: "call.by-name", params: { name: "stage_reset", homeAssistant: "hidden" } });
    assert.deepEqual({ ...m, trigger: r.trigger }, r, "the action, name, enabled state and the rest are untouched");
  });

  test("the cue name avoids what is taken, and never reads as half of a pair", () => {
    const m = makeManual(rule({ name: "Projectors on" }), rule(), new Set(["projectors_on_cue"]));
    assert.equal(m.trigger.params.name, "projectors_on_cue_2");
  });

  test("back from automatic in the same session: the trigger as the editor OPENED it, name, former names and all", () => {
    const seed = cue({ says: "the projectors", aliases: "old_projectors", room: "Booth" });
    const gone = makeAutomatic(seed, seed);
    const back = makeManual(gone, seed, none);
    assert.deepEqual(back.trigger, seed.trigger, "a round trip renamed or lost something");
    // A name the rule would derive differs from the cue's own: it must not win.
    const odd = cue({ name: "projector_power" }, { name: "Projectors" });
    assert.equal(makeManual(makeAutomatic(odd, odd), odd, none).trigger.params.name, "projector_power");
  });
});

describe("homeEntity", () => {
  test("a cue Home Assistant shows has one, named by the cue", () => {
    assert.equal(homeEntity(cue({ name: "Stage_Reset" })), "stage_reset");
  });
  test("not a cue, a hidden cue, a nameless cue, and a lone _on half have none", () => {
    assert.equal(homeEntity(rule()), null);
    assert.equal(homeEntity(cue({ homeAssistant: "hidden" })), null);
    assert.equal(homeEntity(cue({ name: "" })), null);
    assert.equal(homeEntity(cue({ name: "projectors_on" })), null, "the manifest leaves an orphan half out");
  });
});

describe("homeImpact", () => {
  test("a shown cue made automatic LOSES its entity", () => {
    const seed = cue();
    assert.deepEqual(homeImpact(seed, makeAutomatic(seed, seed)), { kind: "lose", cue: "projectors", inHome: true });
    assert.deepEqual(homeImpact(seed, { ...makeAutomatic(seed, seed), trigger: { id: "pco.service-ended", params: {} } }), {
      kind: "lose",
      cue: "projectors",
      inHome: true,
    });
  });

  test("a cue kept out of Home Assistant still loses its name, and the question says Home Assistant is not in it", () => {
    const seed = cue({ homeAssistant: "hidden" });
    const impact = homeImpact(seed, makeAutomatic(seed, seed));
    assert.deepEqual(impact, { kind: "lose", cue: "projectors", inHome: false });
    const q = impactQuestion(impact!);
    assert.match(q.message, /\/api\/cues\/projectors/);
    assert.match(q.message, /console/);
    assert.doesNotMatch(q.message, /Home Assistant removes/);
  });

  test("an automatic rule made manual GAINS nothing while Home Assistant is off, and an entity once it is on", () => {
    const seed = rule();
    const m = makeManual(seed, seed, none);
    assert.equal(homeImpact(seed, m), null);
    const shown = { ...m, trigger: { ...m.trigger, params: { ...m.trigger.params, homeAssistant: "" } } };
    assert.deepEqual(homeImpact(seed, shown), { kind: "gain", cue: "projectors", inHome: true });
  });

  test("nothing is asked when the trigger kind did not change: the Home Assistant switch has its own warning", () => {
    const seed = cue();
    const hidden = { ...seed, trigger: { ...seed.trigger, params: { ...seed.trigger.params, homeAssistant: "hidden" } } };
    assert.equal(homeImpact(seed, hidden), null);
  });

  test("a round trip is no impact at all", () => {
    const seed = cue();
    assert.equal(homeImpact(seed, makeManual(makeAutomatic(seed, seed), seed, none)), null);
  });

  test("the question names the cue and says what is lost", () => {
    const q = impactQuestion({ kind: "lose", cue: "projectors", inHome: true });
    assert.match(q.message, /projectors/);
    assert.match(q.message, /Home Assistant removes/);
    assert.match(q.message, /\/api\/cues\/projectors/);
  });
});
