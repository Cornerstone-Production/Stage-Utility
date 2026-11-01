// The Search tab, wired into automation-section.tsx.
//
// rule-search.test.ts covers the matching logic in isolation; this file is
// only the wiring — that the one box filters the rendered rows across every list,
// that the match count and the "Nothing matches" empty state track it, and that
// clearing the field puts the hint back. Each of the fields the spec calls out
// (command name, says, former name, Companion button label, and the screens a
// command is used on) gets one test here so a search box that stopped reading one
// of them would go red.
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
  ownedBy?: { viewId: string; objectId: string };
}

const CALL_TRIGGER_ID = "call.by-name";

const REGISTRY = {
  triggers: [
    {
      id: CALL_TRIGGER_ID,
      label: "Called by name (voice or HTTP)",
      channel: "cue:call",
      params: [
        { key: "name", label: "Command name", type: "string" },
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
/** What GET /api/cues/usage answers with. */
let USAGE: Record<string, { viewId: string; viewName: string; objectId: string; label: string; home: boolean }[]> = {};

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES.map((r) => ({ ...r, issues: [] })), settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  else if (url.includes("/api/cues/usage")) body = USAGE;
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

async function mount(tab: "commands" | "rules" | "search" = "search") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, { tab })),
    ),
  );
  await settle();
  return view;
}

const searchField = (): HTMLInputElement =>
  document.querySelector('[aria-label="Search automation"]') as HTMLInputElement;

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
  USAGE = {
    projectors_on: [{ viewId: "v1", viewName: "Booth console", objectId: "o1", label: "Big red one", home: false }],
  };
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
    {
      id: "r5",
      name: "Wake displays at 6:00",
      enabled: true,
      trigger: { id: "schedule.weekly", params: {} },
      conditions: [],
      action: { id: "log.message", params: {} },
      cooldownSec: 0,
      oncePerService: false,
    },
    cue({
      id: "r6",
      name: "Shutter",
      trigger: { id: CALL_TRIGGER_ID, params: { name: "btn_shutter" } },
      ownedBy: { viewId: "v2", objectId: "o9" },
    } as Partial<StubRule>),
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

describe("the Search tab", () => {
  test("with no query, no row shows and no count is shown, only what the box matches", async () => {
    await mount();
    assert.equal(visibleRuleNames().length, 0);
    assert.equal(countText(), "");
    assert.match(document.body.textContent ?? "", /Matches command names/);
  });

  test("filters by the command name", async () => {
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

  test("finds a command by the screen it is used on", async () => {
    await mount();
    await type("booth console");
    assert.deepEqual(visibleRuleNames(), ["Projectors ON"]);
  });

  test("finds a command by the label of a Button that names it", async () => {
    await mount();
    await type("big red");
    assert.deepEqual(visibleRuleNames(), ["Projectors ON"]);
  });

  test("searches across every list, each under its own heading", async () => {
    await mount();
    await type("wake");
    assert.deepEqual(visibleRuleNames(), ["Wake displays at 6:00"]);
    assert.deepEqual([...document.querySelectorAll("[data-owned-rule]")].length, 0);
    await type("shutter");
    assert.equal(document.querySelectorAll("[data-owned-rule]").length, 1);
    assert.match(document.body.textContent ?? "", /Belongs to a button/);
  });

  test("shows the match count while a search is active", async () => {
    await mount();
    await type("foyer");
    assert.equal(countText(), "1 match of 6 rules");
  });

  test("shows 'Nothing matches' for a query that hits nothing", async () => {
    await mount();
    await type("nothing-here-at-all");
    assert.equal(visibleRuleNames().length, 0);
    assert.match(document.body.textContent ?? "", /Nothing matches/);
  });

  test("clearing the field takes the rows away again", async () => {
    await mount();
    await type("foyer");
    assert.equal(visibleRuleNames().length, 1);
    await type("");
    assert.equal(visibleRuleNames().length, 0);
    assert.equal(countText(), "");
  });
});
