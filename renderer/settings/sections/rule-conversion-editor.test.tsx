// The single-page editor's manual and automatic faces, and the conversions between
// them, driven through the REAL Automation page against the real routes, engine and
// stage controller on a throwaway data directory.
//
// What is guarded:
//
//  - A MANUAL CUE'S EDITOR has no When and no If: one box says it runs only when
//    called, with Make it automatic. An automatic rule's has Make it manual. A
//    HALF OF AN ON/OFF PAIR has neither: the pair's editor is unchanged.
//  - A CONVERSION KEEPS the action, the name and the enabled state, both ways.
//  - A CONVERSION NEVER RENAMES a cue Home Assistant uses. Going manual -> automatic
//    drops the cue and says so before Save; going back in the same session restores
//    it exactly as it was opened.
//  - THE CUE A CONVERSION MAKES WORKS: Run, POST /api/cues/<name>, the manifest.
//  - A RULE WITH NO TRIGGER CANNOT BE SAVED. Make it automatic leaves the trigger to
//    the operator, and a rule with none never fires.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).
//
// NOT unit-tested here, and driven in a browser instead: the box's dashed border
// and where it sits in the dialog, and the dark and light themes.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "su-conversion-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import { eventually, installRenderDom, settle } from "../../test-dom.js";
const teardown = installRenderDom();

const { automationRoutes } = await import("../../../main/services/routes/automation-routes.js");
const { cueRoutes } = await import("../../../main/services/routes/cue-routes.js");
const { stateRoutes } = await import("../../../main/services/routes/state-routes.js");
const { callRoute } = await import("../../../main/services/routes/route-harness.js");
const { automationEngine } = await import("../../../main/services/automation-engine.js");
const { automationLog } = await import("../../../main/services/automation-log.js");

const { installRealRoutesFetch, BROWSER: browser } = await import("../../test-fixtures/real-routes-fetch.js");
const bridge = installRealRoutesFetch(
  [
    { prefix: "/api/automation/", handler: automationRoutes },
    { prefix: "/api/cues", handler: cueRoutes },
    { prefix: "/api/state", handler: stateRoutes },
  ],
  callRoute,
);

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { AutomationSection } = await import("./automation-section.js");

type Rule = import("../../../main/types/automation.js").Rule;

const rules = (): Rule[] => automationEngine.listRules();
const patches = () => bridge.writes.filter((w) => w.method === "PATCH");

const base = (over: Partial<Omit<Rule, "id">> = {}): Omit<Rule, "id"> => ({
  name: "Stage reset",
  enabled: true,
  trigger: { id: "pco.service-started", params: {} },
  conditions: [],
  action: { id: "log.message", params: { message: "reset" } },
  cooldownSec: 30,
  oncePerService: false,
  ...over,
});
const cueRule = (params: Record<string, string | number> = {}, over: Partial<Omit<Rule, "id">> = {}) =>
  base({ trigger: { id: "call.by-name", params: { name: "stage_reset", ...params } }, cooldownSec: 2, ...over });

let client: InstanceType<typeof QueryClient> | null = null;

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, {}), React.createElement(ConfirmHost, {})),
    ),
  );
  for (let i = 0; i < 3; i++) await settle();
  return view;
}

async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `nothing to press: ${what}`);
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
  await settle();
}

const button = (text: string): HTMLButtonElement | null =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
const switchOf = (label: string): HTMLElement | null => document.querySelector(`[role="switch"][aria-label="${label}"]`);
const manualBox = (): boolean => document.querySelector("[data-manual-cue]") !== null;
const pickerField = (label: string): Element | null => document.querySelector(`[data-picker-field][aria-label="${label}"]`);
const editorOpen = (): boolean => document.querySelector("[data-rule-editor]") !== null;
const labelled = (text: string): HTMLInputElement | null => {
  const row = [...document.querySelectorAll("label")].find((l) => (l.textContent ?? "").startsWith(text));
  return row?.querySelector("input") ?? null;
};

const openRow = (name: string) =>
  press(document.querySelector(`[data-rule-name="${name}"]`)?.closest("button"), `the row ${name}`);

async function pickOption(id: string) {
  for (const h of [...document.querySelectorAll("[data-picker-group]")]) {
    if (document.querySelector(`[data-picker-option="${id}"]`)) break;
    await press(h, "a picker heading");
  }
  await press(document.querySelector(`[data-picker-option="${id}"]`), id);
}

/** The editor closes only once the save has fully landed: the write is on disk, the
 *  server has answered and the page has handled the answer. The engine changes its
 *  rules in memory BEFORE the disk write, so a test that reads the engine after
 *  pressing Save sees the change while the rest of the save is still running, and
 *  on the file's last test that rest finishes after the DOM is torn down. */
const saveLanded = () => eventually(() => assert.equal(editorOpen(), false, "Save asked a question, or did not close"));

/** Press Save and, when Save asks about Home Assistant, answer. Returns once the
 *  save has landed, except on Cancel, which saves nothing. */
async function save(answer: "confirm" | "cancel" | "none" = "none") {
  await press(button("Save"), "Save");
  if (answer === "none") return saveLanded();
  const ask = await eventually(() => {
    const el = [...document.querySelectorAll("[role=alertdialog], [role=dialog]")].find((d) => !d.hasAttribute("data-rule-editor"));
    assert.ok(el, "Save did not ask about Home Assistant");
    return el;
  });
  const labels = answer === "confirm" ? ["Save anyway", "Save"] : ["Cancel"];
  const btn = [...ask.querySelectorAll("button")].find((b) => labels.includes(b.textContent?.trim() ?? ""));
  await press(btn, `the ${answer} button`);
  if (answer === "confirm") await saveLanded();
}

before(async () => {
  await automationEngine.init();
});
after(async () => {
  cleanup();
  client?.clear();
  await settle();
  teardown();
  await fs.rm(TMP, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const r of rules()) await automationEngine.removeRule(r.id);
  await automationLog.clear();
  await automationEngine.setSettings({ simulate: true, disarmed: false });
  bridge.writes.length = 0;
});
afterEach(async () => {
  cleanup();
  client?.clear();
  await settle();
});

describe("the two faces", () => {
  test("a manual cue's editor has the box and Make it automatic, and no When, If or trigger picker", async () => {
    await automationEngine.addRule(cueRule());
    await mount();
    await openRow("Stage reset");
    assert.equal(manualBox(), true, "no manual box");
    assert.equal(document.querySelector("[data-rule-editor] [data-manual-kind]")?.textContent, "Manual cue", "the title does not say what kind it is");
    assert.ok(document.body.textContent?.includes("Runs only when called"));
    assert.ok(button("Make it automatic"), "no Make it automatic");
    assert.equal(button("Make it manual") === null, true, "a manual cue offered Make it manual");
    assert.equal(pickerField("Trigger") === null, true, "a manual cue still has a trigger to pick");
    assert.equal(pickerField("Add condition") === null, true, "a manual cue still has conditions to add");
    for (const section of ["When", "If"]) {
      const heads = [...document.querySelectorAll("[data-rule-editor] span")].filter((s) => s.textContent === section);
      assert.equal(heads.length, 0, `a manual cue still has a ${section} section`);
    }
    // And what it does have: the action, the switches, the cooldown, the cue's own fields.
    assert.ok(pickerField("Action"), "no Action");
    assert.ok(switchOf("Shown in Home Assistant"), "no Home Assistant switch");
    assert.ok(switchOf("Allowed during a service"), "no Allowed during a service switch");
    assert.ok(labelled("Cooldown"), "no Cooldown");
    assert.ok(labelled("Cue name"), "the cue name can no longer be seen or edited");
  });

  test("an automatic rule's editor has Make it manual and When and If", async () => {
    await automationEngine.addRule(base());
    await mount();
    await openRow("Stage reset");
    assert.equal(manualBox(), false);
    assert.equal(document.querySelector("[data-manual-kind]") === null, true, "an automatic rule was titled a manual cue");
    assert.ok(button("Make it manual"), "no Make it manual");
    assert.equal(button("Make it automatic") === null, true);
    assert.ok(pickerField("Trigger"));
    assert.ok(pickerField("Add condition"));
  });

  test("Called by name is not offered as a trigger to an automatic rule", async () => {
    await automationEngine.addRule(base());
    await mount();
    await openRow("Stage reset");
    await press(pickerField("Trigger"), "Trigger");
    for (const h of [...document.querySelectorAll("[data-picker-group]")]) await press(h, "a heading");
    assert.equal(document.querySelector('[data-picker-option="call.by-name"]') === null, true);
  });

  test("a cue's other conditions are still shown and removable, though it cannot add one", async () => {
    await automationEngine.addRule(
      cueRule({}, {
        conditions: [
          { id: "service.is-not-live", params: {} },
          { id: "obs.is-recording", params: {} },
        ],
      }),
    );
    await mount();
    await openRow("Stage reset");
    assert.equal(switchOf("Allowed during a service")?.getAttribute("aria-checked"), "false", "the guard is the switch");
    assert.ok(document.body.textContent?.includes("OBS is recording"), "a condition the cue carries is hidden from it");
    assert.equal(document.querySelectorAll('[aria-label="Remove condition"]').length, 1, "the guard was repeated as a row");
  });

  test("a half of an ON/OFF pair has neither button nor the box: the pair's editor is unchanged", async () => {
    for (const half of ["on", "off"]) {
      await automationEngine.addRule(
        cueRule({ name: `projectors_${half}` }, { name: `Projectors ${half}` }),
      );
    }
    await mount();
    await press(document.querySelector('[aria-label="Projectors pair"]'), "the pair row");
    assert.equal(editorOpen(), true);
    assert.equal(manualBox(), false, "a pair half got the manual box");
    assert.equal(button("Make it manual") === null, true);
    assert.equal(button("Make it automatic") === null, true);
    assert.ok(pickerField("Trigger"), "a half lost its trigger row");
    assert.ok(pickerField("Add condition"), "a half lost its If section");
  });
});

describe("Make it manual", () => {
  test("keeps the action, name and enabled state; the cue gets a derived name, Home Assistant off, and works", async () => {
    await automationEngine.addRule(base({ name: "Projectors on", enabled: false, cooldownSec: 45 }));
    await mount();
    await openRow("Projectors on");
    await press(button("Make it manual"), "Make it manual");
    assert.equal(manualBox(), true, "the editor did not become the manual one");
    assert.deepEqual(patches(), [], "pressing Make it manual wrote something: it is a draft change");
    await save();

    const [r] = rules();
    assert.deepEqual(r.trigger, { id: "call.by-name", params: { name: "projectors_on_cue", homeAssistant: "hidden" } });
    assert.equal(r.name, "Projectors on");
    assert.equal(r.enabled, false, "the enabled state changed");
    assert.deepEqual(r.action, { id: "log.message", params: { message: "reset" } });
    assert.equal(r.cooldownSec, 45, "the cooldown was changed without being asked");

    // The cue works: the console's manifest lists it, and the route fires it.
    const manifest = (await callRoute(cueRoutes, "/api/cues/manifest?all=1", { headers: browser })).json as {
      buttons: { id: string }[];
    };
    assert.ok(manifest.buttons.some((b) => b.id === "projectors_on_cue"));
    // Disabled, so the call is refused for that and for nothing else.
    const call = await callRoute(cueRoutes, "/api/cues/projectors_on_cue", { method: "POST", headers: browser, body: {} });
    assert.notEqual(call.status, 404, "the cue the conversion made does not resolve");
  });

  test("Home Assistant gains nothing, so Save does not ask; and nothing Home Assistant reads lists it", async () => {
    await automationEngine.addRule(base());
    await mount();
    await openRow("Stage reset");
    await press(button("Make it manual"), "Make it manual");
    await save();
    const forHome = (await callRoute(cueRoutes, "/api/cues/manifest", { headers: browser })).json as {
      buttons: { id: string; builtin?: true }[];
    };
    assert.deepEqual(forHome.buttons.filter((b) => !b.builtin).map((b) => b.id), []);
  });

  test("switching Home Assistant on afterwards asks before Save, and Cancel saves nothing", async () => {
    await automationEngine.addRule(base());
    await mount();
    await openRow("Stage reset");
    await press(button("Make it manual"), "Make it manual");
    await press(switchOf("Shown in Home Assistant"), "Home Assistant");
    await save("cancel");
    assert.deepEqual(patches(), [], "Cancel on the question still saved");
    assert.equal(rules()[0].trigger.id, "pco.service-started");
    await save("confirm");
    assert.equal(rules()[0].trigger.params.homeAssistant, "");
    assert.equal(rules()[0].trigger.id, "call.by-name");
  });
});

describe("Make it automatic", () => {
  test("a rule with no trigger cannot be saved, and the editor says so", async () => {
    await automationEngine.addRule(cueRule({ homeAssistant: "hidden" }));
    await mount();
    await openRow("Stage reset");
    await press(button("Make it automatic"), "Make it automatic");
    assert.equal(manualBox(), false, "the box is still there");
    assert.ok(document.querySelector("[data-picking-trigger]"), "nothing says a trigger is needed");
    assert.equal(button("Save")?.disabled, true, "Save was open on a rule with no trigger");
    assert.deepEqual(patches(), []);
  });

  test("keeps the action, name and enabled state, and Home Assistant is asked before it loses the cue", async () => {
    await automationEngine.addRule(cueRule({ says: "reset" }, { enabled: true }));
    await mount();
    await openRow("Stage reset");
    await press(button("Make it automatic"), "Make it automatic");
    assert.ok(
      (document.querySelector("[data-picking-trigger]")?.textContent ?? "").includes("stage_reset"),
      "the note does not say which cue goes",
    );
    await press(pickerField("Trigger"), "Trigger");
    await pickOption("pco.service-ended");
    assert.equal(button("Save")?.disabled, false);

    await save("cancel");
    assert.deepEqual(patches(), [], "Cancel on the question still saved");
    assert.equal(rules()[0].trigger.id, "call.by-name", "the cue was removed without the question being answered");

    await save("confirm");
    const [r] = rules();
    assert.deepEqual(r.trigger, { id: "pco.service-ended", params: {} });
    assert.equal(r.name, "Stage reset");
    assert.equal(r.enabled, true);
    assert.deepEqual(r.action, { id: "log.message", params: { message: "reset" } });
    // The cue is gone from everything that called it by name.
    const call = await callRoute(cueRoutes, "/api/cues/stage_reset", { method: "POST", headers: browser, body: {} });
    assert.equal(call.status, 404, "the old cue name still resolves");
    const manifest = (await callRoute(cueRoutes, "/api/cues/manifest?all=1", { headers: browser })).json as {
      buttons: { id: string; builtin?: true }[];
    };
    assert.deepEqual(manifest.buttons.filter((b) => !b.builtin).map((b) => b.id), []);
  });

  test("a cue kept out of Home Assistant still has callers, so Save asks, naming the URL and console buttons", async () => {
    await automationEngine.addRule(cueRule({ homeAssistant: "hidden" }, { enabled: false }));
    await mount();
    await openRow("Stage reset");
    await press(button("Make it automatic"), "Make it automatic");
    await press(pickerField("Trigger"), "Trigger");
    await pickOption("pco.service-ended");
    await press(button("Save"), "Save");
    const ask = await eventually(() => {
      const el = [...document.querySelectorAll("[role=alertdialog], [role=dialog]")].find((d) => !d.hasAttribute("data-rule-editor"));
      assert.ok(el, "Save did not ask");
      return el;
    });
    const said = ask.textContent ?? "";
    assert.ok(said.includes("/api/cues/stage_reset"), `the URL is not named: ${said}`);
    assert.ok(said.includes("console"), `console buttons are not named: ${said}`);
    assert.equal(said.includes("Home Assistant removes"), false, "it claimed Home Assistant loses an entity it never had");
    assert.deepEqual(patches(), [], "it saved before the answer");
    await press([...ask.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save anyway"), "Save anyway");
    await saveLanded();
    assert.equal(rules()[0].trigger.id, "pco.service-ended");
    assert.equal(rules()[0].enabled, false);
  });
});

describe("Make it automatic, saved over an issue", () => {
  const askOpen = () =>
    [...document.querySelectorAll("[role=alertdialog], [role=dialog]")].some((d) => !d.hasAttribute("data-rule-editor"));

  test("the cue is gone after the first save, so the second save does not say it goes away again", async () => {
    await automationEngine.addRule(cueRule({ homeAssistant: "hidden" }, { enabled: true }));
    await mount();
    await openRow("Stage reset");
    await press(button("Make it automatic"), "Make it automatic");
    await press(pickerField("Trigger"), "Trigger");
    // Its one field is required and left blank, so the server saves the rule forced off.
    await pickOption("pco.item-reached");
    await press(button("Save"), "Save");
    await eventually(() => assert.equal(askOpen(), true, "the first save did not ask"));
    const yes = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save anyway");
    await press(yes, "Save anyway");
    await eventually(() => assert.equal(rules()[0].trigger.id, "pco.item-reached", "the first save did not land"));
    await eventually(() => assert.equal(askOpen(), false));
    assert.equal(editorOpen(), true, "an unfinished rule closed the editor");
    assert.equal(rules()[0].enabled, false, "the server should have saved it turned off");

    const before = patches().length;
    // The rule lands in the store before the save's answer reaches the editor,
    // which reads "Saving…" until it does.
    await eventually(() => assert.ok(button("Save"), "the first save never finished"));
    await press(button("Save"), "Save again");
    await settle();
    assert.equal(askOpen(), false, "the second save asked again whether the cue goes away, though it already has");
    assert.ok(patches().length > before, "the second save sent nothing");
    await eventually(() => assert.ok(button("Save"), "the second save never finished"));
  });
});

describe("a conversion never renames a cue", () => {
  test("manual, automatic, manual again in one session saves no change to the trigger at all", async () => {
    await automationEngine.addRule(cueRule({ says: "reset the stage", aliases: "old_reset", room: "Booth" }));
    await mount();
    await openRow("Stage reset");
    await press(button("Make it automatic"), "Make it automatic");
    await press(button("Make it manual"), "Make it manual");
    assert.equal(manualBox(), true);
    assert.equal(labelled("Cue name")?.value, "stage_reset", "the cue was renamed by going there and back");
    await save();
    // Nothing changed, so what is sent (if anything) carries no trigger.
    const sentTriggers = patches().filter((p) => p.body && "trigger" in (JSON.parse(p.body) as object));
    assert.equal(sentTriggers.length, 0, "a round trip wrote the trigger");
    const [r] = rules();
    assert.deepEqual(r.trigger, { id: "call.by-name", params: { name: "stage_reset", says: "reset the stage", aliases: "old_reset", room: "Booth" } });
  });

  test("what was changed on the cue before converting is still changed when converting back", async () => {
    await automationEngine.addRule(cueRule());
    await mount();
    await openRow("Stage reset");
    const name = labelled("Cue name");
    assert.ok(name, "no Cue name field");
    await act(async () => {
      fireEvent.change(name, { target: { value: "stage_reset_two" } });
    });
    await press(button("Make it automatic"), "Make it automatic");
    await press(button("Make it manual"), "Make it manual");
    assert.equal(labelled("Cue name")?.value, "stage_reset_two", "converting back restored the opened cue, not the edited one");
  });

  test("a rule made manual is never given a name another cue or former name holds", async () => {
    await automationEngine.addRule(cueRule({ aliases: "stage_reset_2" }, { name: "Existing" }));
    await automationEngine.addRule(base({ name: "Stage reset" }));
    await mount();
    await openRow("Stage reset");
    await press(button("Make it manual"), "Make it manual");
    await save();
    const made = rules().find((r) => r.name === "Stage reset")!;
    assert.equal(made.trigger.params.name, "stage_reset_3", "stage_reset is taken, and stage_reset_2 is a former name");
  });
});
