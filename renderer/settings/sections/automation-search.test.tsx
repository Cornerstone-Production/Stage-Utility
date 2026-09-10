// The rules-list search field, wired into automation-section.tsx.
//
// rule-search.test.ts covers the matching logic in isolation; this file is
// only the wiring — that the field actually filters the rendered rows, that
// the "N of M rules" count and the "No rules match" empty state track it, and
// that clearing the field brings every row back. Each of the four fields the
// spec calls out (cue name, says, former name, button label) gets one test
// here so a search box that stopped reading one of them would go red.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see
// automation-rule-row.test.tsx for why.

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
      ],
    },
  ],
  conditions: [],
  actions: [
    { id: "companion.press", label: "Press a Companion button", params: [] },
    { id: "log.message", label: "Write a log message", params: [] },
  ],
};

let RULES: StubRule[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES, settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  else if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
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

const searchField = (): HTMLInputElement =>
  document.querySelector('[aria-label="Search rules"]') as HTMLInputElement;

async function type(text: string) {
  await act(async () => {
    fireEvent.change(searchField(), { target: { value: text } });
  });
  await settle();
}

/** The rule-name text on every visible row, in order. */
const visibleRuleNames = (): string[] =>
  [...document.querySelectorAll("[data-rule-name]")].map((el) => el.getAttribute("data-rule-name") ?? "");

const countText = (): string => document.querySelector("[data-rule-search-count]")?.textContent ?? "";

const cue = (over: Partial<StubRule> = {}): StubRule => ({
  id: over.id ?? "rule-1",
  name: over.name ?? "Rule",
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name: "cue_name", says: "" } },
  conditions: [],
  action: { id: "log.message", params: {} },
  cooldownSec: 0,
  oncePerService: false,
  ...over,
});

beforeEach(() => {
  RULES = [
    cue({ id: "r1", name: "Projectors ON", trigger: { id: CALL_TRIGGER_ID, params: { name: "projectors_on", says: "the projectors" } } }),
    cue({ id: "r2", name: "Foyer TVs OFF", trigger: { id: CALL_TRIGGER_ID, params: { name: "foyer_tvs_off", says: "the foyer screens" } } }),
    cue({
      id: "r3",
      name: "House Lights",
      trigger: { id: CALL_TRIGGER_ID, params: { name: "house_lights_on", says: "house lights", aliases: "stage_wash" } },
    }),
    cue({
      id: "r4",
      name: "Spot cue",
      trigger: { id: CALL_TRIGGER_ID, params: { name: "spot_go", says: "" } },
      action: { id: "companion.press", params: { label: "Stage Left Spot", page: 1, row: 0, col: 1 } },
    }),
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

describe("the rules-list search field", () => {
  test("with no query, every rule shows and no count is shown", async () => {
    await mount();
    assert.equal(visibleRuleNames().length, 4);
    assert.equal(countText(), "");
  });

  test("filters by the cue name", async () => {
    await mount();
    await type("foyer_tvs_off");
    assert.deepEqual(visibleRuleNames(), ["Foyer TVs OFF"]);
  });

  test("filters by 'says'", async () => {
    await mount();
    await type("house lights");
    assert.deepEqual(visibleRuleNames(), ["House Lights"]);
  });

  test("filters by a former name (alias)", async () => {
    await mount();
    await type("stage_wash");
    assert.deepEqual(visibleRuleNames(), ["House Lights"]);
  });

  test("filters by a Companion button label", async () => {
    await mount();
    await type("Stage Left Spot");
    assert.deepEqual(visibleRuleNames(), ["Spot cue"]);
  });

  test("shows 'N of M rules' while a search is active", async () => {
    await mount();
    await type("foyer");
    assert.equal(countText(), "1 of 4 rules");
  });

  test("shows 'No rules match' for a query that hits nothing", async () => {
    await mount();
    await type("nothing-here-at-all");
    assert.equal(visibleRuleNames().length, 0);
    assert.match(document.body.textContent ?? "", /No rules match/);
  });

  test("clearing the field restores every rule", async () => {
    await mount();
    await type("foyer");
    assert.equal(visibleRuleNames().length, 1);
    await type("");
    assert.equal(visibleRuleNames().length, 4);
    assert.equal(countText(), "");
  });
});
