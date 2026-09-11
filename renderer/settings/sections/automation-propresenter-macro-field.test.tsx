// The ProPresenter macro dropdown in the rule editor.
//
// The macro list comes off a LAN round trip to a booth machine, so it is
// EMPTY whenever that machine is off — which is most of the week, and is
// exactly when somebody sits down to write a rule. A <select> whose value is
// not among its options renders blank, so without carrying the stored value
// the field reads "Pick one…" for a rule that has already picked one, and the
// operator's next move is to re-pick a setting that was never lost.
//
// Both halves are driven here: the dropdown offers what the route returned, and
// a stored macro the route did NOT return still shows.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time.
//
// NOT unit-tested here, and driven in a browser instead: that the marked
// fallback option is visually distinguishable from a real one, and that a long
// macro name does not push the field out of the dialog. jsdom loads no
// stylesheet and reports every offsetHeight as 0, so neither is observable in
// it.

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

/** Cut to what the section reads, with the real action's two enum params. */
const REGISTRY = {
  triggers: [
    {
      id: "service.live",
      label: "Service goes live",
      channel: "pco:live",
      params: [],
    },
  ],
  conditions: [],
  actions: [
    {
      id: "propresenter.macro",
      label: "Trigger a ProPresenter macro",
      params: [
        { key: "instance", label: "ProPresenter", type: "enum", optionsFrom: "propresenter-instances" },
        { key: "macro", label: "Macro", type: "enum", optionsFrom: "propresenter-macros" },
      ],
    },
  ],
};

let RULES: StubRule[] = [];
/** What the macro option route answers — empty models a booth machine that is off. */
let MACRO_ITEMS: { value: string; label: string }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES, settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/automation/propresenter-instances")) {
    body = { items: [{ value: "default", label: "MA" }] };
  } else if (url.includes("/api/automation/propresenter-macros")) body = { items: MACRO_ITEMS };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  else if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { AutomationSection } = await import("./automation-section.js");

/** Several macrotasks: the queries, their re-renders and the portals are turns. */
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

let client: InstanceType<typeof QueryClient> | null = null;

async function open(): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, {})),
    ),
  );
  await settle();
  fireEvent.click(screen.getByText("Doors macro"));
  await settle();
}

const rule = (macro: string): StubRule => ({
  id: "rule-1",
  name: "Doors macro",
  enabled: true,
  trigger: { id: "service.live", params: {} },
  conditions: [],
  action: { id: "propresenter.macro", params: { instance: "default", macro } },
  cooldownSec: 0,
  oncePerService: false,
});

/** The Macro field's options, as plain strings — never as DOM nodes. */
function macroOptions(): string[] {
  const selects = [...document.querySelectorAll("select")];
  // The Macro select is the one whose options carry a macro name; the editor
  // also renders selects for the trigger, the action and the instance.
  const target = selects.find((s) =>
    [...s.options].some((o) => o.value === "SONG INTRO" || o.value === "DOORS"),
  );
  return target ? [...target.options].map((o) => `${o.value}|${o.textContent ?? ""}`) : [];
}

/** What the Macro select currently holds. */
function macroValue(): string {
  const selects = [...document.querySelectorAll("select")];
  const target = selects.find((s) =>
    [...s.options].some((o) => o.value === "SONG INTRO" || o.value === "DOORS"),
  );
  return target ? target.value : "(no macro select)";
}

beforeEach(() => {
  RULES = [rule("DOORS")];
  MACRO_ITEMS = [
    { value: "DOORS", label: "DOORS" },
    { value: "SONG INTRO", label: "SONG INTRO" },
  ];
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

describe("the ProPresenter macro field", () => {
  test("offers the macros the route returned", async () => {
    await open();
    assert.deepEqual(macroOptions(), ["|Pick one…", "DOORS|DOORS", "SONG INTRO|SONG INTRO"]);
    assert.equal(macroValue(), "DOORS");
  });

  test("carries the label the route built, including the instance suffix", async () => {
    MACRO_ITEMS = [{ value: "DOORS", label: "DOORS (MA only)" }];
    await open();
    assert.deepEqual(macroOptions(), ["|Pick one…", "DOORS|DOORS (MA only)"]);
  });

  test("a stored macro the booth machine did not report still shows, marked", async () => {
    // ProPresenter is off: the route answered with an empty list. The rule still
    // holds SONG INTRO, and the field has to say so.
    RULES = [rule("SONG INTRO")];
    MACRO_ITEMS = [];
    await open();
    assert.deepEqual(macroOptions(), ["|Pick one…", "SONG INTRO|SONG INTRO (not in the current list)"]);
    assert.equal(macroValue(), "SONG INTRO", "the field lost the macro the rule holds");
  });

  test("a macro renamed in ProPresenter still shows the name the rule holds", async () => {
    // The list came back fine; the rule's macro simply is not in it any more.
    RULES = [rule("SONG INTRO")];
    MACRO_ITEMS = [{ value: "DOORS", label: "DOORS" }];
    await open();
    assert.deepEqual(macroOptions(), [
      "|Pick one…",
      "DOORS|DOORS",
      "SONG INTRO|SONG INTRO (not in the current list)",
    ]);
    assert.equal(macroValue(), "SONG INTRO");
  });

  test("a rule with no macro chosen is NOT given a phantom option", async () => {
    RULES = [rule("")];
    await open();
    assert.deepEqual(macroOptions(), ["|Pick one…", "DOORS|DOORS", "SONG INTRO|SONG INTRO"]);
    assert.equal(macroValue(), "");
  });
});
