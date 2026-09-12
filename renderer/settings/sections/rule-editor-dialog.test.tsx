// The rule editor as a DIALOG: what opens it, what it writes, what it throws
// away.
//
// Each of these is a silent failure from the operator's side:
//
//  - A ROW THAT OPENS NOTHING. The row is the only way into the editor now, so
//    a press that does not open it is a rule nobody can change.
//  - CANCEL THAT SAVES. Escape, the overlay and Cancel are one thing — a
//    discard. A Cancel that wrote would save a half-typed cue name, and the
//    server accepts anything that parses.
//  - A PAIR WITH TWO OF EACH SETTING. A pair is ONE switch in Home Assistant;
//    two Home Assistant switches in its dialog are two settings for one entity,
//    free to disagree, with nothing on screen saying which one won.
//  - A PAIR SAVED BY HALVES. Both halves are written, the ON half first — the
//    pair's settings live there (cue-pairs.ts), and a write that stopped after
//    one leaves a rules file whose off cue claims settings the on cue lost.
//  - A DELETE THAT LEAVES HALF A PAIR. `projectors_off` alone is a cue that
//    turns something off and nothing that turns it on, and it is still a live
//    URL.
//  - ADD RULE THAT LANDS NOWHERE. "Rule 7" with a log action is the start of a
//    rule; an operator left looking at a list of two hundred has to find it
//    again to say what it does.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and was killed with no line number.
//
// NOT unit-tested here, and driven in a browser instead: that the dialog's body
// scrolls with the footer staying on screen at 1280x800, that the overlay dims
// the list behind it, and that the selected tab reads as selected. jsdom loads
// no stylesheet and reports every offsetHeight as 0, so a max height, an
// overflow and a colour are not observable in it at all.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

interface StubRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { id: string; params: Record<string, string | number> };
  conditions: { id: string; params: Record<string, string | number> }[];
  action: { id: string; params: Record<string, string | number> };
  cooldownSec: number;
  oncePerService: boolean;
}

const CALL_TRIGGER_ID = "call.by-name";

const REGISTRY = {
  triggers: [
    {
      id: CALL_TRIGGER_ID,
      label: "Called by name (voice or HTTP)",
      channel: "cue:call",
      params: [
        { key: "name", label: "Cue name", type: "string" },
        { key: "says", label: "Spoken as", type: "string", optional: true },
        { key: "room", label: "Room", type: "string", optional: true },
        { key: "stateVariable", label: "State variable", type: "string", optional: true },
        { key: "stateOnValue", label: "Value meaning on", type: "string", optional: true },
        { key: "stateOffValue", label: "Value meaning off", type: "string", optional: true },
      ],
    },
    { id: "pco.plan-item", label: "A plan item starts", channel: "pco:plan", params: [] },
    {
      id: "occupancy.threshold",
      label: "Occupancy crosses a threshold",
      channel: "people:changed",
      params: [{ key: "metric", label: "Metric", type: "enum", options: [{ value: "attendance", label: "Attendance" }] }],
    },
  ],
  conditions: [{ id: "service.is-not-live", label: "No service is live", params: [] }],
  actions: [
    { id: "companion.press", label: "Press a Companion button", params: [] },
    { id: "log.message", label: "Write a log message", params: [] },
  ],
};

const cue = (name: string, params: Record<string, string | number> = {}): StubRule => ({
  id: `rule-${name}`,
  name: `Rule ${name}`,
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name, ...params } },
  conditions: [],
  action: { id: "companion.press", params: { page: 1, row: 0, col: 1 } },
  cooldownSec: 0,
  oncePerService: false,
});

let RULES: StubRule[] = [];
let requests: { method: string; url: string; body: string | null }[] = [];
/** What POST /api/automation/rules answers with, so Add rule has an id. */
let CREATED: StubRule | null = null;
/** A rule id the server refuses to update, as it refuses a duplicate cue name. */
let REFUSE: { id: string; error: string } | null = null;

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (method !== "GET") {
    requests.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    const id = url.split("/").pop() ?? "";
    if (method === "PATCH" && REFUSE?.id === id) {
      const refusal = REFUSE;
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: refusal.error }),
        text: async () => JSON.stringify({ error: refusal.error }),
      };
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body)) as Partial<StubRule>;
      RULES = RULES.map((r) => (r.id === id ? { ...r, ...patch } : r));
    }
    if (method === "DELETE") RULES = RULES.filter((r) => r.id !== id);
    if (method === "POST" && url.endsWith("/api/automation/rules") && CREATED) {
      RULES = [...RULES, CREATED];
      const created = CREATED;
      return { ok: true, status: 201, json: async () => created, text: async () => JSON.stringify(created) };
    }
  }
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES, settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  else if (url.includes("/api/cues/states")) body = { ok: true, checkedAt: "x", states: {} };
  else if (url.includes("/api/companion/pairs")) {
    body = { ok: true, pairs: [], buttons: [], customVariables: [] };
  } else if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { AutomationSection } = await import("./automation-section.js");

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

let client: InstanceType<typeof QueryClient> | null = null;

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  // ConfirmHost as well as the section: the app mounts one beside the toaster,
  // and Delete asks through it. Without it the promise never resolves and the
  // delete silently does nothing — which is what the operator would see.
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(AutomationSection, {}),
        React.createElement(ConfirmHost, {}),
      ),
    ),
  );
  await settle();
  return view;
}

async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `nothing to press: ${what}`);
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}

/** The open editor's marker, or "" when none is mounted. */
const editor = (): string =>
  document.querySelector("[data-rule-editor]")?.getAttribute("data-rule-editor") ?? "";

const editors = (): number => document.querySelectorAll("[data-rule-editor]").length;

/** One field in the open editor, by the label its row carries. */
function field(label: string): HTMLInputElement | null {
  const row = [...document.querySelectorAll("label")].find((el) =>
    (el.textContent ?? "").startsWith(label),
  );
  return row?.querySelector("input") ?? null;
}

/** The native <select> Row renders for a field, by the label its row carries. */
function selectField(label: string): HTMLSelectElement | null {
  const row = [...document.querySelectorAll("label")].find((el) =>
    (el.textContent ?? "").startsWith(label),
  );
  return row?.querySelector("select") ?? null;
}

const button = (text: string): HTMLButtonElement | null =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;

const tab = (starts: string): HTMLElement | null =>
  ([...document.querySelectorAll('[role="tab"]')].find((el) =>
    (el.textContent ?? "").startsWith(starts),
  ) as HTMLElement) ?? null;

const openRow = async (ruleName: string) =>
  press(document.querySelector(`[data-rule-name="${ruleName}"]`)?.closest("button"), ruleName);

const openPair = async (name: string) =>
  press(document.querySelector(`[aria-label="${name} pair"]`), `${name} pair`);

async function typeIn(el: HTMLInputElement | null, value: string, what: string) {
  assert.ok(el, `no field to type in: ${what}`);
  await act(async () => {
    fireEvent.change(el!, { target: { value } });
  });
  await settle();
}

const writes = () => requests.filter((r) => r.url.includes("/api/automation/rules/"));

beforeEach(() => {
  RULES = [];
  CREATED = null;
  REFUSE = null;
  requests = [];
});
afterEach(async () => {
  cleanup();
  client?.clear();
  await settle();
});
after(async () => {
  cleanup();
  await settle();
  teardown();
});

describe("one rule", () => {
  beforeEach(() => {
    RULES = [cue("take_screens", { says: "the screens" })];
  });

  test("pressing its row opens the editor, with its fields in it", async () => {
    await mount();
    assert.equal(editors(), 0, "an editor was mounted before anything was pressed");
    await openRow("Rule take_screens");
    assert.equal(editor(), "rule-take_screens");
    assert.equal(field("Name")?.value, "Rule take_screens");
    assert.equal(field("Cue name")?.value, "take_screens");
    assert.equal(field("Spoken as")?.value, "the screens");
  });

  test("Cancel throws the change away and writes nothing", async () => {
    await mount();
    await openRow("Rule take_screens");
    await typeIn(field("Cue name"), "the_screens", "Cue name");
    await press(button("Cancel"), "Cancel");

    assert.equal(editors(), 0, "Cancel left the editor open");
    assert.deepEqual(writes(), [], "Cancel saved the draft");
    // And re-opening shows the stored rule, not what was typed.
    await openRow("Rule take_screens");
    assert.equal(field("Cue name")?.value, "take_screens");
  });

  test("Save writes the change and closes", async () => {
    await mount();
    await openRow("Rule take_screens");
    await typeIn(field("Name"), "Screens", "Name");
    await press(button("Save"), "Save");

    assert.equal(editors(), 0, "a saved editor stayed open");
    const saved = writes();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.method, "PATCH");
    assert.equal(saved[0]?.url.endsWith("/api/automation/rules/rule-take_screens"), true);
    assert.equal((JSON.parse(String(saved[0]?.body)) as { name: string }).name, "Screens");
  });

  test("a rule that is not a cue gets no pair section and no halves", async () => {
    RULES = [
      {
        id: "rule-plan",
        name: "Lights at item 3",
        enabled: true,
        trigger: { id: "pco.plan-item", params: {} },
        conditions: [],
        action: { id: "log.message", params: {} },
        cooldownSec: 0,
        oncePerService: false,
      },
    ];
    await mount();
    await openRow("Lights at item 3");
    assert.equal(editor(), "rule-plan");
    assert.equal(document.querySelectorAll("[data-pair-settings]").length, 0);
    assert.equal(document.querySelectorAll('[role="tab"]').length, 0);
  });
});

describe("a pair", () => {
  beforeEach(() => {
    RULES = [
      cue("projectors_on", { says: "the projectors on", room: "Auditorium" }),
      cue("projectors_off"),
    ];
  });

  test("opens ONE dialog, with the pair's settings exactly once", async () => {
    await mount();
    await openPair("the projectors");
    assert.equal(editors(), 1, "a pair opened more than one editor");
    assert.equal(
      document.querySelectorAll('[data-pair-settings] [aria-label="Shown in Home Assistant"]').length,
      1,
      "the pair's Home Assistant switch is not in This pair exactly once",
    );
    assert.equal(
      document.querySelectorAll('[aria-label="Shown in Home Assistant"]').length,
      1,
      "a second Home Assistant switch rendered outside This pair",
    );
    // The pair's, not the half's: the room the ON half carries, in the pair
    // section, and not repeated in the half below it.
    assert.equal(document.querySelectorAll('[aria-label="Room"]').length, 1);
    assert.equal(field("Room")?.value, "Auditorium");
  });

  test("the segmented control swaps the cue name between the halves", async () => {
    await mount();
    await openPair("the projectors");
    assert.equal(field("Cue name")?.value, "projectors_on");
    await press(tab("Turn off"), "the Turn off tab");
    assert.equal(
      field("Cue name")?.value,
      "projectors_off",
      "the Turn off tab still showed the ON half's fields",
    );
    await press(tab("Turn on"), "the Turn on tab");
    assert.equal(field("Cue name")?.value, "projectors_on");
  });

  test("Save writes BOTH halves, the ON half first", async () => {
    await mount();
    await openPair("the projectors");
    await press(tab("Turn off"), "the Turn off tab");
    await typeIn(field("Name"), "Projectors OFF", "Name");
    await press(button("Save"), "Save");

    const saved = writes();
    assert.deepEqual(
      saved.map((r) => `${r.method} ${r.url.split("/").pop()}`),
      ["PATCH rule-projectors_on", "PATCH rule-projectors_off"],
    );
    assert.equal(
      (JSON.parse(String(saved[1]?.body)) as { name: string }).name,
      "Projectors OFF",
      "the OFF half's own edit was not saved",
    );
  });

  test("the Home Assistant switch writes the ON half", async () => {
    await mount();
    await openPair("the projectors");
    await press(document.querySelector('[aria-label="Shown in Home Assistant"]'), "the Home switch");
    await press(button("Save"), "Save");

    const saved = writes();
    const on = JSON.parse(String(saved[0]?.body)) as { trigger: { params: Record<string, string> } };
    const off = JSON.parse(String(saved[1]?.body)) as { trigger: { params: Record<string, string> } };
    assert.equal(on.trigger.params.homeAssistant, "hidden");
    assert.notEqual(off.trigger.params.homeAssistant, "hidden");
  });

  test("a setting the OFF half carries alone is shown, and moves to the ON half", async () => {
    // A hand-edited rules file. The server reads the ON half first and the OFF
    // half as a fallback (cuePairs, cue-manifest), so this pair really is
    // hidden and really is bound — the dialog has to say so, and saving has to
    // put both where the editor writes them.
    RULES = [
      cue("projectors_on", { says: "the projectors on" }),
      cue("projectors_off", { homeAssistant: "hidden", stateVariable: "projectors_state" }),
    ];
    await mount();
    await openPair("the projectors");
    // Inside the pair's own section, not the first [data-cue-home] in the
    // document: the ROW carries one too, and it is computed by cuePairs — so an
    // unscoped query reads the row's answer and passes whatever the dialog says.
    assert.equal(
      document.querySelector("[data-pair-settings] [data-cue-home]")?.getAttribute("data-cue-home"),
      "hidden",
      "a pair hidden by its off half read as shown",
    );
    await press(button("Save"), "Save");

    const saved = writes();
    const on = JSON.parse(String(saved[0]?.body)) as { trigger: { params: Record<string, string> } };
    const off = JSON.parse(String(saved[1]?.body)) as { trigger: { params: Record<string, string> } };
    assert.deepEqual(
      { hidden: on.trigger.params.homeAssistant, variable: on.trigger.params.stateVariable },
      { hidden: "hidden", variable: "projectors_state" },
    );
    assert.deepEqual(
      { hidden: off.trigger.params.homeAssistant, variable: off.trigger.params.stateVariable },
      { hidden: "", variable: "" },
      "the pair's settings were left on the off half as well, free to disagree",
    );
  });

  test("the allowed-during-a-service switch writes both halves", async () => {
    // No fallback exists for this one: the engine evaluates each half against
    // its OWN conditions. Written to the ON half alone, the off cue would go on
    // refusing mid-service with the switch on screen saying it was allowed.
    RULES = [
      { ...cue("projectors_on"), conditions: [{ id: "service.is-not-live", params: {} }] },
      { ...cue("projectors_off"), conditions: [{ id: "service.is-not-live", params: {} }] },
    ];
    await mount();
    await openPair("Projectors");
    const guard = document.querySelector('[aria-label="Allowed during a service"]');
    assert.equal(guard?.getAttribute("aria-checked"), "false");
    await press(guard, "the service guard switch");
    await press(button("Save"), "Save");

    const saved = writes();
    assert.deepEqual(
      saved.map((r) => (JSON.parse(String(r.body)) as { conditions: unknown[] }).conditions),
      [[], []],
    );
  });

  test("a refused save keeps the dialog open with both drafts intact", async () => {
    // The server refuses a duplicate or malformed cue name with a 400. A dialog
    // that closed on that would lose the change and read as a save — and on a
    // pair the ON half is already written, so the drafts are the only place the
    // rest of the operator's edit still exists.
    REFUSE = { id: "rule-projectors_off", error: "cue name already in use" };
    await mount();
    await openPair("the projectors");
    await press(tab("Turn off"), "the Turn off tab");
    await typeIn(field("Cue name"), "beamers_off", "Cue name");
    await press(button("Save"), "Save");

    assert.equal(editors(), 1, "a refused save closed the editor");
    assert.equal(field("Cue name")?.value, "beamers_off", "the refused draft was thrown away");
    await press(tab("Turn on"), "the Turn on tab");
    assert.equal(field("Cue name")?.value, "projectors_on", "the other half's draft was thrown away");
    assert.deepEqual(
      writes().map((r) => r.url.split("/").pop()),
      ["rule-projectors_on", "rule-projectors_off"],
      "the ON half was not written before the refusal",
    );
  });

  test("Delete removes BOTH halves, after a confirm naming both", async () => {
    await mount();
    await openPair("the projectors");
    await press(button("Delete"), "Delete");
    assert.match(
      document.body.textContent ?? "",
      /projectors_on and projectors_off/,
      "the confirm did not name both cues",
    );
    assert.deepEqual(writes(), [], "the pair was deleted before the confirm was answered");

    await press(button("Delete both"), "Delete both");
    assert.deepEqual(
      writes().map((r) => `${r.method} ${r.url.split("/").pop()}`),
      ["DELETE rule-projectors_on", "DELETE rule-projectors_off"],
    );
    assert.equal(editors(), 0, "the editor stayed open over a rule that is gone");
  });

  test("Test fires the half that is selected, and says which", async () => {
    await mount();
    await openPair("the projectors");
    assert.equal(button("Test turn on") === null, false, "the Test button did not name the half");
    await press(tab("Turn off"), "the Turn off tab");
    await press(button("Test turn off"), "Test turn off");
    assert.deepEqual(
      requests.filter((r) => r.url.endsWith("/test")).map((r) => r.url.split("/").at(-2)),
      ["rule-projectors_off"],
    );
  });
});

describe("Add rule", () => {
  test("opens the new rule's editor", async () => {
    RULES = [cue("take_screens")];
    CREATED = {
      id: "rule-new",
      name: "Rule 2",
      enabled: false,
      trigger: { id: CALL_TRIGGER_ID, params: {} },
      conditions: [],
      action: { id: "log.message", params: { message: "rule matched" } },
      cooldownSec: 30,
      oncePerService: false,
    };
    await mount();
    await press(button("Add rule"), "Add rule");
    assert.equal(editor(), "rule-new", "the new rule was added with nowhere to say what it does");
    assert.equal(field("Name")?.value, "Rule 2");
  });
});

// The class of bug this guards: a native <select> whose value matches no
// <option> renders BLANK rather than the value it was given (see select.tsx).
// A rule saved under an older release can still name a trigger, action or enum
// param value this registry no longer lists — a type renamed or retired since.
// Reverting any of the three Select conversions below back to a raw <select>
// (rule-editor-dialog.tsx's Trigger row, Action row, or ParamField's
// enum/multi-enum branch) turns these tests red.
describe("a rule naming a trigger, action or param value the registry no longer lists", () => {
  test("the Trigger and Action selects still show the stored ids, not blank", async () => {
    RULES = [
      {
        id: "rule-retired",
        name: "Rule retired",
        enabled: true,
        trigger: { id: "obs.retired-trigger", params: {} },
        conditions: [],
        action: { id: "action.retired", params: {} },
        cooldownSec: 0,
        oncePerService: false,
      },
    ];
    await mount();
    await openRow("Rule retired");

    const trigger = selectField("Trigger");
    assert.ok(trigger, "no Trigger select rendered");
    assert.notEqual(trigger!.selectedIndex, -1, "the Trigger control rendered blank");
    assert.equal(trigger!.value, "obs.retired-trigger", "the stored trigger id must be what the control reads");
    const triggerOpt = [...trigger!.options].find((o) => o.value === "obs.retired-trigger");
    assert.ok(
      triggerOpt?.textContent?.includes("not found"),
      `the stored trigger id must be labelled as no longer offered, got ${JSON.stringify(triggerOpt?.textContent)}`,
    );

    const action = selectField("Action");
    assert.ok(action, "no Action select rendered");
    assert.notEqual(action!.selectedIndex, -1, "the Action control rendered blank");
    assert.equal(action!.value, "action.retired", "the stored action id must be what the control reads");
  });

  test("a stale enum param value is shown on its ParamField Select, not blank", async () => {
    RULES = [
      {
        id: "rule-stale-metric",
        name: "Rule stale metric",
        enabled: true,
        // "occupancy.threshold" IS in the registry, so its params render — the
        // "metric" value below is what has gone stale, not the trigger itself.
        trigger: { id: "occupancy.threshold", params: { metric: "occupancy" } },
        conditions: [],
        action: { id: "log.message", params: {} },
        cooldownSec: 0,
        oncePerService: false,
      },
    ];
    await mount();
    await openRow("Rule stale metric");

    const metric = selectField("Metric");
    assert.ok(metric, "no Metric select rendered");
    assert.notEqual(metric!.selectedIndex, -1, "the Metric control rendered blank");
    assert.equal(metric!.value, "occupancy", "the stored metric value must be what the control reads");
    const metricOpt = [...metric!.options].find((o) => o.value === "occupancy");
    assert.ok(
      metricOpt?.textContent?.includes("not found"),
      `the stored metric value must be labelled as no longer offered, got ${JSON.stringify(metricOpt?.textContent)}`,
    );
  });
});
