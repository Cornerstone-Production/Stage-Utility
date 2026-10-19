// The New cue flow's model, over the REAL registries: what a step needs before
// Next, the defaults of each kind, and the exact rule Create writes.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

// rule-editor-dialog (which the model reads the registry shape from) imports UI
// that touches the DOM at load.
const teardown = installRenderDom();
after(() => teardown());

const { AUTOMATION_TRIGGERS } = await import("@main/services/automation-triggers.js");
const { AUTOMATION_ACTIONS } = await import("@main/services/automation-actions.js");
const { AUTOMATION_CONDITIONS } = await import("@main/services/automation-conditions.js");
const { reservedCueNames } = await import("@main/services/builtin-cues.js");
const {
  AUTO_COOLDOWN_SEC,
  AUTO_STEPS,
  MANUAL_COOLDOWN_SEC,
  MANUAL_STEPS,
  buildRule,
  cooldownOf,
  newCueName,
  displayName,
  emptyDraft,
  enabledOf,
  reachable,
  stepComplete,
  stepIssues,
  stepsFor,
  suggestedName,
  takenCueNames,
} = await import("./new-cue-flow.js");
type CueDraft = import("./new-cue-flow.js").CueDraft;

const registry = {
  triggers: Object.values(AUTOMATION_TRIGGERS).map(({ id, label, channel, params, help }) => ({ id, label, channel, params, help })),
  conditions: Object.values(AUTOMATION_CONDITIONS).map(({ id, label, params, help }) => ({ id, label, params, help })),
  actions: Object.values(AUTOMATION_ACTIONS).map(({ id, label, params, help }) => ({ id, label, params, help })),
  reservedCueNames: [...reservedCueNames()],
};

const none = new Set<string>();

const manual = (over: Partial<CueDraft> = {}): CueDraft => ({
  ...emptyDraft("manual"),
  action: { id: "log.message", params: { message: "hello" } },
  ...over,
});
const auto = (over: Partial<CueDraft> = {}): CueDraft => ({
  ...emptyDraft("auto"),
  trigger: { id: "pco.service-started", params: {} },
  action: { id: "log.message", params: { message: "hello" } },
  ...over,
});

describe("steps", () => {
  test("a manual cue's, in order, with On a console the only optional one", () => {
    assert.deepEqual(MANUAL_STEPS.map((s) => s.label), [
      "Kind",
      "What it does",
      "Name and where it fires",
      "On a console",
      "Review",
    ]);
    assert.deepEqual(MANUAL_STEPS.filter((s) => s.optional).map((s) => s.id), ["console"]);
  });

  test("an automatic rule's, with If the only optional one", () => {
    assert.deepEqual(AUTO_STEPS.map((s) => s.label), ["Kind", "When", "If", "Then", "Name and safety", "Review"]);
    assert.deepEqual(AUTO_STEPS.filter((s) => s.optional).map((s) => s.id), ["if"]);
  });

  test("with no kind chosen there is one step", () => {
    assert.deepEqual(stepsFor(null).map((s) => s.id), ["kind"]);
  });
});

describe("defaults", () => {
  test("a manual cue starts ON, with a 2 second cooldown, allowed during a service and not in Home Assistant", () => {
    const d = emptyDraft("manual");
    assert.equal(enabledOf(d), true);
    assert.equal(cooldownOf(d), MANUAL_COOLDOWN_SEC);
    assert.equal(MANUAL_COOLDOWN_SEC, 2);
    assert.equal(d.allowedDuringService, true);
    assert.equal(d.homeAssistant, false);
  });

  test("an automatic rule starts OFF, with a 30 second cooldown, once per service off", () => {
    const d = emptyDraft("auto");
    assert.equal(enabledOf(d), false);
    assert.equal(cooldownOf(d), AUTO_COOLDOWN_SEC);
    assert.equal(AUTO_COOLDOWN_SEC, 30);
    assert.equal(d.oncePerService, false);
  });

  test("what the operator sets beats the default, including a zero cooldown and an off switch", () => {
    assert.equal(cooldownOf({ ...emptyDraft("manual"), cooldownSec: 0 }), 0);
    assert.equal(enabledOf({ ...emptyDraft("manual"), enabled: false }), false);
    assert.equal(enabledOf({ ...emptyDraft("auto"), enabled: true }), true);
  });
});

describe("what a step needs before Next", () => {
  test("the first step needs a kind", () => {
    assert.equal(stepComplete("kind", emptyDraft(), registry), false);
    assert.equal(stepComplete("kind", emptyDraft("manual"), registry), true);
  });

  test("When needs a trigger, and its required params", () => {
    assert.equal(stepComplete("trig", emptyDraft("auto"), registry), false, "no trigger chosen");
    const item = auto({ trigger: { id: "pco.item-reached", params: {} } });
    assert.equal(stepComplete("trig", item, registry), false, "item title is required and empty");
    assert.deepEqual(stepIssues("trig", item, registry).map((i) => i.label), ["Item title contains"]);
    assert.equal(
      stepComplete("trig", auto({ trigger: { id: "pco.item-reached", params: { title: "Sermon" } } }), registry),
      true,
    );
  });

  test("Then needs an action and its required params, as the editor's Needs setup reads them", () => {
    assert.equal(stepComplete("act", manual({ action: { id: "", params: {} } }), registry), false);
    const press = manual({ action: { id: "companion.press", params: {} } });
    assert.equal(stepComplete("act", press, registry), false, "no Companion button picked");
    const rosstalk = manual({ action: { id: "rosstalk.command", params: {} } });
    assert.equal(stepComplete("act", rosstalk, registry), false, "no target or command");
    assert.equal(stepComplete("act", manual(), registry), true);
  });

  test("If needs nothing when empty, and a condition's required fields when it has one", () => {
    assert.equal(stepComplete("if", auto(), registry), true);
    const layer = auto({ conditions: [{ id: "pvp.layer-is-muted", params: {} }] });
    assert.equal(stepComplete("if", layer, registry), false, "a layer condition needs a layer");
    assert.equal(
      stepComplete("if", auto({ conditions: [{ id: "pvp.layer-is-muted", params: { layer: "Lyrics" } }] }), registry),
      true,
    );
  });

  test("Name, console and review need nothing", () => {
    for (const id of ["name", "console", "review"] as const) assert.equal(stepComplete(id, manual(), registry), true);
  });

  test("a step later than the first undone one is not reachable", () => {
    const d = manual({ action: { id: "", params: {} } });
    assert.equal(reachable(1, d, registry), true, "What it does is next after Kind");
    assert.equal(reachable(2, d, registry), false, "Name comes after an action that is not chosen");
    assert.equal(reachable(2, manual(), registry), true);
  });
});

describe("names", () => {
  test("a manual cue is suggested its action, an automatic rule when → then", () => {
    assert.equal(suggestedName(manual(), registry), "Write a log message");
    assert.equal(suggestedName(auto(), registry), "Service goes live → Write a log message");
    assert.equal(suggestedName(emptyDraft("auto"), registry), "");
  });

  test("a typed name wins, and a blank one uses the suggestion", () => {
    assert.equal(displayName(manual({ name: "  Projectors on  " }), registry), "Projectors on");
    assert.equal(displayName(manual({ name: "   " }), registry), "Write a log message");
  });

  test("the taken names are every cue's name and former names, and the built-ins", () => {
    const taken = takenCueNames(
      [
        { trigger: { id: "call.by-name", params: { name: "Stage_Reset", aliases: "old_reset, older_reset" } } },
        { trigger: { id: "pco.service-started", params: { name: "not_a_cue" } } },
      ],
      ["obs_record_on"],
    );
    assert.deepEqual([...taken].sort(), ["obs_record_on", "old_reset", "older_reset", "stage_reset"]);
  });

  test("the cue name is derived from the display name and avoids what is taken", () => {
    const d = manual({ name: "Stage reset" });
    assert.equal(newCueName(d, registry, none), "stage_reset");
    assert.equal(newCueName(d, registry, new Set(["stage_reset"])), "stage_reset_2");
    assert.equal(newCueName(manual({ name: "Projectors on" }), registry, none), "projectors_on_cue");
  });
});

describe("the rule Create writes", () => {
  test("a manual cue, exactly", () => {
    const rule = buildRule(manual({ name: "Stage reset" }), registry, none);
    assert.deepEqual(rule, {
      name: "Stage reset",
      enabled: true,
      trigger: { id: "call.by-name", params: { name: "stage_reset", homeAssistant: "hidden" } },
      conditions: [],
      action: { id: "log.message", params: { message: "hello" } },
      cooldownSec: 2,
      oncePerService: false,
    });
  });

  test("Home Assistant on writes the cue shown; not allowed during a service writes the guard", () => {
    const rule = buildRule(manual({ name: "Stage reset", homeAssistant: true, allowedDuringService: false }), registry, none);
    assert.deepEqual(rule.trigger.params, { name: "stage_reset", homeAssistant: "" });
    assert.deepEqual(rule.conditions, [{ id: "service.is-not-live", params: {} }]);
  });

  test("a manual cue with the switch turned off is written off", () => {
    assert.equal(buildRule(manual({ name: "x", enabled: false }), registry, none).enabled, false);
  });

  test("an automatic rule, exactly, off by default", () => {
    const rule = buildRule(
      auto({ name: "Start the log", conditions: [{ id: "service.type-is", params: { serviceTypeId: "7" } }] }),
      registry,
      none,
    );
    assert.deepEqual(rule, {
      name: "Start the log",
      enabled: false,
      trigger: { id: "pco.service-started", params: {} },
      conditions: [{ id: "service.type-is", params: { serviceTypeId: "7" } }],
      action: { id: "log.message", params: { message: "hello" } },
      cooldownSec: 30,
      oncePerService: false,
    });
  });

  test("an automatic rule keeps its cooldown, once-per-service and an explicit ON", () => {
    const rule = buildRule(auto({ cooldownSec: 120, oncePerService: true, enabled: true }), registry, none);
    assert.equal(rule.cooldownSec, 120);
    assert.equal(rule.oncePerService, true);
    assert.equal(rule.enabled, true);
    assert.equal(rule.name, "Service goes live → Write a log message", "a blank name is the suggestion");
  });

  test("an automatic rule never carries the Called by name trigger or a cue name", () => {
    const rule = buildRule(auto(), registry, none);
    assert.notEqual(rule.trigger.id, "call.by-name");
    assert.equal("name" in rule.trigger.params, false);
  });
});
