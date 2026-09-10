// The state field for a cue that drives REAPER rather than a Companion button.
//
// A Record/Stop pair is bound to `app:reaper.recording` by the server whether or
// not anybody picks it (cue-pairs.ts), and the editor has to say so: a "State
// variable" reading blank on a pair whose switch reports a real state is a field
// that contradicts the thing it configures, and the two value rows under it
// would be settings that cannot change anything.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time.
//
// The ui `Select` is a NATIVE select (renderer/components/ui/select.tsx), so its
// options are in the markup and can be asserted — including whether each can be
// chosen, which is how "there is nothing to clear" is told apart from a real
// "No state" choice.
//
// NOT unit-tested here, and driven in a browser instead: that the hint popover
// sits over the field rather than off the edge of the panel, and that the row
// does not reflow when the two value rows disappear. jsdom loads no stylesheet
// and reports every offsetHeight as 0.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

interface StubRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { id: string; params: Record<string, string | number> };
  conditions: never[];
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
        { key: "stateVariable", label: "State variable", type: "string", optional: true },
        { key: "stateOnValue", label: "Value meaning on", type: "string", optional: true },
        { key: "stateOffValue", label: "Value meaning off", type: "string", optional: true },
      ],
    },
  ],
  conditions: [],
  actions: [
    { id: "companion.press", label: "Press a Companion button", params: [] },
    {
      id: "reaper.transport",
      label: "REAPER transport",
      params: [
        {
          key: "command",
          label: "Command",
          type: "enum",
          options: [
            { value: "record", label: "Start recording" },
            { value: "stop", label: "Stop" },
            { value: "play", label: "Play" },
          ],
        },
      ],
    },
  ],
};

/** A cue running a REAPER transport command. */
const transport = (name: string, command: string, params: Record<string, string> = {}): StubRule => ({
  id: `rule-${name}`,
  name,
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name, says: name, ...params } },
  conditions: [],
  action: { id: "reaper.transport", params: { command } },
  cooldownSec: 0,
  oncePerService: false,
});

let RULES: StubRule[] = [];
/** What `integrations:list` says is set up. */
let CONFIGURED: string[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES, settings: { simulate: false, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  else if (url.includes("/api/cues/states")) body = { ok: true, checkedAt: "x", states: {} };
  else if (url.includes("/api/integrations")) {
    body = { descriptors: [], states: CONFIGURED.map((id) => ({ id, configured: true })) };
  } else if (url.includes("/api/companion/pairs")) {
    body = { ok: true, pairs: [], buttons: [], customVariables: [] };
  } else if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
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
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, {})),
    ),
  );
  await settle();
  return view;
}

async function open(name: string): Promise<void> {
  await act(async () => {
    screen.getByText(name).click();
  });
  await settle();
}

/** The accessible names of every field the open editor renders. */
const fieldNames = (): string[] =>
  [...document.querySelectorAll("input[aria-label], select[aria-label], button[aria-label]")].map(
    (el) => el.getAttribute("aria-label") ?? "",
  );

/** The State variable control, or null when it fell back to a text field. */
const stateVariableSelect = (): HTMLSelectElement | null =>
  document.querySelector('select[aria-label="State variable"]');

const stateVariableValue = (): string => stateVariableSelect()?.value ?? "MISSING";

/**
 * Every option, and whether it can be CHOSEN.
 *
 * The two matter separately: the ui Select emits its placeholder as a disabled,
 * hidden empty option, and emits a selectable empty one instead when the caller
 * supplies "No state". So `{ value: "", selectable: false }` is "there is
 * nothing to clear" and `{ value: "", selectable: true }` is the real choice.
 */
const stateVariableOptions = (): { value: string; selectable: boolean }[] =>
  [...(stateVariableSelect()?.options ?? [])].map((o) => ({ value: o.value, selectable: !o.disabled }));

beforeEach(() => {
  RULES = [];
  CONFIGURED = ["reaper"];
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

describe("a REAPER Record/Stop pair's state field", () => {
  test("shows the app source as what it reads, with nothing stored", async () => {
    RULES = [transport("reaper_record_on", "record"), transport("reaper_record_off", "stop")];
    await mount();
    await open("reaper_record_on");
    assert.equal(fieldNames().includes("State variable"), true);
    assert.equal(stateVariableValue(), "app:reaper.recording");
    // And "No state" is not offered: nothing is stored, so clearing it would
    // re-render as the app source — a control that visibly does nothing.
    assert.deepEqual(stateVariableOptions(), [
      { value: "", selectable: false },
      { value: "app:reaper.recording", selectable: true },
    ]);
  });

  test("says where the state comes from, on the field itself", async () => {
    // The hint lives in a popover, so it is opened here rather than read off the
    // markup. Without it the field reads as a Companion variable nobody has set,
    // and an operator goes looking in Companion for a binding that is not there.
    RULES = [transport("reaper_record_on", "record"), transport("reaper_record_off", "stop")];
    await mount();
    await open("reaper_record_on");
    const row = [...document.querySelectorAll("label")].find((el) =>
      (el.textContent ?? "").includes("State variable"),
    );
    assert.equal(row === undefined, false, "no State variable row at all");
    await act(async () => {
      row?.querySelector("button")?.click();
    });
    await settle();
    assert.match(
      document.body.textContent ?? "",
      /Read from Stage Utility's REAPER connection\. Nothing to set up\./,
    );
  });

  test("hides the two value rows, which it cannot change", async () => {
    // With the source STORED, not merely implied: an unbound pair hides those
    // rows anyway, so the implicit case alone would pass whatever this does.
    RULES = [
      transport("reaper_record_on", "record", {
        stateVariable: "app:reaper.recording",
        stateOnValue: "on",
        stateOffValue: "off",
      }),
      transport("reaper_record_off", "stop"),
    ];
    await mount();
    await open("reaper_record_on");
    const names = fieldNames();
    assert.equal(stateVariableValue(), "app:reaper.recording");
    assert.equal(names.includes("Value meaning on"), false, "an app source's values are fixed");
    assert.equal(names.includes("Value meaning off"), false);
  });

  test("a Companion-bound pair still gets its two value rows", async () => {
    // The other side of the rule above: hiding them for every pair would take a
    // real setting away from every Companion binding in the building.
    RULES = [
      transport("reaper_record_on", "record", { stateVariable: "rec_state" }),
      transport("reaper_record_off", "stop"),
    ];
    await mount();
    await open("reaper_record_on");
    const names = fieldNames();
    assert.equal(names.includes("Value meaning on"), true);
    assert.equal(names.includes("Value meaning off"), true);
  });

  test("a Play/Stop pair implies nothing, and reads as unbound", async () => {
    RULES = [transport("reaper_play_on", "play"), transport("reaper_play_off", "stop")];
    await mount();
    await open("reaper_play_on");
    assert.equal(fieldNames().includes("State variable"), true);
    assert.equal(stateVariableValue(), "", "a Play cue was bound to REAPER's recording state");
    // Still OFFERED, because REAPER is set up: an operator who wants it can
    // pick it. Only the implication is absent — and "No state" is a real choice
    // here, because there is something to leave unbound.
    assert.deepEqual(stateVariableOptions(), [
      { value: "", selectable: true },
      { value: "app:reaper.recording", selectable: true },
    ]);
  });

  test("with REAPER not set up, the app source is not offered at all", async () => {
    // Nothing to read from an integration that has never been configured, and a
    // binding to it would report unknown for ever with the field looking right.
    CONFIGURED = [];
    RULES = [transport("reaper_play_on", "play"), transport("reaper_play_off", "stop")];
    await mount();
    await open("reaper_play_on");
    assert.equal(stateVariableSelect(), null, "an unconfigured integration was offered as a source");
    // The field is still there as a text box — an operator can type a Companion
    // variable, which is what it falls back to with nothing to offer.
    assert.equal(fieldNames().includes("State variable"), true);
  });

  test("the action's command select is offered, with REAPER's three commands", async () => {
    // The action picker takes its fields from the registry, so a static-options
    // enum has to render as a picker rather than a text box — a rule whose
    // command was typed by hand is a rule that fails at the first call.
    RULES = [transport("reaper_record_on", "record"), transport("reaper_record_off", "stop")];
    await mount();
    await open("reaper_record_on");
    const selects = [...document.querySelectorAll("select")].map((el) => ({
      value: el.value,
      options: [...el.options].map((o) => o.value),
    }));
    const command = selects.find((s) => s.options.includes("record"));
    assert.equal(command === undefined, false, "the command param rendered no picker at all");
    assert.deepEqual(command?.options, ["", "record", "stop", "play"]);
    assert.equal(command?.value, "record");
  });
});
