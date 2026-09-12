// The OSC target dropdown in the rule editor.
//
// `osc.send` declared optionsFrom: "osc-targets" from the day it was written
// and nothing in the renderer ever answered that name, so the Target select
// rendered with "Pick one..." and no options at all — the action could not be
// configured, on any install, ever. It is the sibling of "rosstalk-targets",
// which was wired; this one was missed.
//
// The guard is at this level rather than over `dynamicOptions` directly,
// because the object is a local inside the section: only a render can say
// whether the name resolves.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time.
//
// NOT unit-tested here, and driven in a browser instead: how the select looks
// at a narrow width. jsdom loads no stylesheet and reports every offsetHeight
// as 0.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const REGISTRY = {
  triggers: [{ id: "service.live", label: "Service goes live", channel: "pco:live", params: [] }],
  conditions: [],
  actions: [
    {
      id: "osc.send",
      label: "Send an OSC message",
      params: [
        { key: "targetId", label: "Target", type: "enum", optionsFrom: "osc-targets" },
        { key: "address", label: "Address", type: "string" },
      ],
    },
  ],
};

const RULES = [
  {
    id: "rule-1",
    name: "Mute the wedge",
    enabled: true,
    trigger: { id: "service.live", params: {} },
    conditions: [],
    action: { id: "osc.send", params: { targetId: "x32", address: "/ch/01/mix/on" } },
    cooldownSec: 0,
    oncePerService: false,
  },
];

/** What /api/osc/targets answers. A case rewrites this to a NON-array. */
let OSC_BODY: unknown = [
  { id: "x32", name: "X32 Rack" },
  { id: "qlab", name: "QLab" },
];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES, settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/automation/propresenter-instances")) body = { items: [] };
  else if (url.includes("/api/automation/propresenter-macros")) body = { items: [] };
  else if (url.includes("/api/osc/targets")) body = OSC_BODY;
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
  fireEvent.click(screen.getByText("Mute the wedge"));
  await settle();
}

/** The Target select's options, as plain strings — never as DOM nodes. */
function targetOptions(): string[] {
  const s = [...document.querySelectorAll("select")].find((x) =>
    [...x.options].some((o) => o.value === "x32"),
  );
  return s ? [...s.options].map((o) => `${o.value}|${o.textContent ?? ""}`) : [];
}

afterEach(async () => {
  cleanup();
  client?.clear();
  await settle();
  OSC_BODY = [
    { id: "x32", name: "X32 Rack" },
    { id: "qlab", name: "QLab" },
  ];
});
after(async () => {
  cleanup();
  await settle();
  teardown();
});

describe("the OSC target field", () => {
  test("offers the configured OSC targets", async () => {
    await open();
    assert.deepEqual(targetOptions(), ["|Pick one…", "x32|X32 Rack", "qlab|QLab"]);
  });

  test("an option source that answers with an OBJECT does not take the section down", async () => {
    // `?? []` guards null and undefined and nothing else, so an error body
    // reached `.map` and threw inside the useMemo — which unmounts the whole
    // Automation section, not just this field. The operator gets a blank page
    // where their rules were. An empty dropdown is the right failure.
    OSC_BODY = { error: "OSC is not configured" };
    await open();
    // Reaching the editor at all is the assertion: the rule's own name is on
    // screen, so the section rendered rather than throwing on mount.
    assert.equal(screen.getAllByText("Mute the wedge").length > 0, true);
    // No real options — and the rule's own target still shown, marked, by the
    // stored-value fallback. The two behave correctly together.
    assert.deepEqual(targetOptions(), ["|Pick one…", "x32|x32 · not found"]);
  });
});
