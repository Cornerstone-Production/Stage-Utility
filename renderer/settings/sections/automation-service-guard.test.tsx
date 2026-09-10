// The "allowed during a service" switch and its two rules-list badges.
//
// `service.is-not-live` is what refuses a cue while a service is live or about
// to start — automation-conditions.ts, service-guard.ts. This file is the
// wiring: that the switch READS the condition's presence, that flipping it
// writes exactly that condition added or removed with every other condition
// untouched, and that the list row's badge follows the same presence.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see
// automation-rule-row.test.tsx for why: node:assert inspects a live jsdom
// element for its failure message and does not terminate.
//
// NOT unit-tested here, and driven in a browser instead: that the amber badge
// reads as amber and the service-safe one reads quiet. jsdom loads no
// stylesheet, so a colour is not observable in it at all.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

interface StubCondition {
  id: string;
  params: Record<string, string | number>;
}

interface StubRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { id: string; params: Record<string, string | number> };
  conditions: StubCondition[];
  action: { id: string; params: Record<string, string | number> };
  cooldownSec: number;
  oncePerService: boolean;
}

const CALL_TRIGGER_ID = "call.by-name";
const GUARD_ID = "service.is-not-live";

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
  conditions: [
    { id: GUARD_ID, label: "No service is live", params: [] },
    { id: "service.type-is", label: "Service type is", params: [] },
  ],
  actions: [{ id: "log.message", label: "Write a log message", params: [] }],
};

let RULES: StubRule[] = [];
/** The body of the last PATCH the switch sent, or null if none yet. */
let lastPatch: unknown = null;

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (init?.method === "PATCH" && url.includes("/api/automation/rules/")) {
    lastPatch = JSON.parse(String(init.body));
    const id = url.split("/").pop();
    RULES = RULES.map((r) => (r.id === id ? { ...r, ...(lastPatch as Partial<StubRule>) } : r));
    return { ok: true, status: 200, json: async () => RULES[0], text: async () => "{}" };
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

const cue = (over: Partial<StubRule> = {}): StubRule => ({
  id: "rule-1",
  name: "Projectors ON",
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name: "projectors_on", says: "the projectors" } },
  conditions: [{ id: GUARD_ID, params: {} }],
  action: { id: "log.message", params: { message: "x" } },
  cooldownSec: 0,
  oncePerService: false,
  ...over,
});

const badge = (): string => document.querySelector("[data-service-guard]")?.getAttribute("data-service-guard") ?? "none";

async function openRow() {
  const nameButtons = [...document.querySelectorAll("button")];
  const rowButton = nameButtons.find((b) => b.textContent?.includes("Projectors ON"));
  assert.ok(rowButton, "row button not found");
  await act(async () => {
    fireEvent.click(rowButton!);
  });
  await settle();
}

const guardSwitch = (): HTMLElement | null =>
  document.querySelector('[aria-label="Allowed during a service"]');

beforeEach(() => {
  RULES = [cue()];
  lastPatch = null;
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

describe("the rules-list badge", () => {
  test("reads 'off' (amber, any time) when the cue has no guard condition", async () => {
    RULES = [cue({ conditions: [] })];
    await mount();
    assert.equal(badge(), "off");
  });

  test("reads 'on' (service-safe) when the cue has the guard condition", async () => {
    RULES = [cue({ conditions: [{ id: GUARD_ID, params: {} }] })];
    await mount();
    assert.equal(badge(), "on");
  });
});

describe("the allowed-during-a-service switch", () => {
  test("is OFF when the rule carries the guard condition", async () => {
    RULES = [cue({ conditions: [{ id: GUARD_ID, params: {} }] })];
    await mount();
    await openRow();
    const el = guardSwitch();
    assert.ok(el, "switch not found");
    assert.equal(el!.getAttribute("aria-checked"), "false");
  });

  test("is ON when the rule carries no guard condition", async () => {
    RULES = [cue({ conditions: [] })];
    await mount();
    await openRow();
    const el = guardSwitch();
    assert.ok(el, "switch not found");
    assert.equal(el!.getAttribute("aria-checked"), "true");
  });

  test("flipping it ON removes the guard condition and leaves others untouched", async () => {
    RULES = [
      cue({
        conditions: [
          { id: "service.type-is", params: { serviceTypeId: "sunday" } },
          { id: GUARD_ID, params: {} },
        ],
      }),
    ];
    await mount();
    await openRow();
    const el = guardSwitch();
    assert.ok(el, "switch not found");
    await act(async () => {
      fireEvent.click(el!);
    });
    await settle();
    // The Save button appears once the draft is dirty.
    const saveButtons = [...document.querySelectorAll("button")].filter((b) => b.textContent === "Save");
    assert.equal(saveButtons.length, 1, "no Save button after flipping the switch");
    await act(async () => {
      fireEvent.click(saveButtons[0]!);
    });
    await settle();
    const patch = lastPatch as { conditions?: StubCondition[] };
    assert.ok(patch.conditions, "no conditions in the saved patch");
    assert.deepEqual(patch.conditions, [{ id: "service.type-is", params: { serviceTypeId: "sunday" } }]);
  });

  test("flipping it OFF (back to guarded) adds exactly the guard condition, once", async () => {
    RULES = [
      cue({
        conditions: [{ id: "service.type-is", params: { serviceTypeId: "sunday" } }],
      }),
    ];
    await mount();
    await openRow();
    const el = guardSwitch();
    assert.ok(el, "switch not found");
    await act(async () => {
      fireEvent.click(el!);
    });
    await settle();
    const saveButtons = [...document.querySelectorAll("button")].filter((b) => b.textContent === "Save");
    assert.equal(saveButtons.length, 1);
    await act(async () => {
      fireEvent.click(saveButtons[0]!);
    });
    await settle();
    const patch = lastPatch as { conditions?: StubCondition[] };
    assert.deepEqual(patch.conditions, [
      { id: "service.type-is", params: { serviceTypeId: "sunday" } },
      { id: GUARD_ID, params: {} },
    ]);
  });

  test("a rule with the guard twice loses BOTH when the switch turns on", async () => {
    RULES = [
      cue({
        conditions: [{ id: GUARD_ID, params: {} }, { id: GUARD_ID, params: {} }],
      }),
    ];
    await mount();
    await openRow();
    const el = guardSwitch();
    await act(async () => {
      fireEvent.click(el!);
    });
    await settle();
    const saveButtons = [...document.querySelectorAll("button")].filter((b) => b.textContent === "Save");
    await act(async () => {
      fireEvent.click(saveButtons[0]!);
    });
    await settle();
    const patch = lastPatch as { conditions?: StubCondition[] };
    assert.deepEqual(patch.conditions, []);
  });
});
