// The Companion button status ON THE RULES-LIST ROW.
//
// The pill itself is covered in companion-button-status.test.tsx, which renders
// `CueButtonStatus` on its own. That says the component works; it says nothing
// about whether the rules list renders it, and the wiring is one line in
// automation-section.tsx that nothing else touches. A `missing` cue REFUSES to
// press rather than guessing at a coordinate, so this pill is the only warning
// an operator gets — a row that dropped it would look exactly like a healthy
// cue.
//
// Two halves, and both have to hold:
//
//  - a `companion.press` rule whose last reconcile came back `missing` shows
//    the pill in its row,
//  - a rule with any other action shows nothing. A grey pill on every log-message
//    rule in the list is noise, and readFingerprint would happily read a
//    `status` param off an action that has none.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and was killed with no line number.
//
// NOT unit-tested here, and driven in a browser instead: that the pill sits
// inside the row's own button (so pressing the warning opens the editor that
// fixes it), that amber reads as amber and red as red, and that a long detail
// truncates instead of pushing Test off the row. jsdom loads no stylesheet and
// reports every offsetHeight as 0, so none of those is observable in it.

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

/** The registry the section renders its fields from, cut to what it reads. */
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

const { render, cleanup, act } = await import("@testing-library/react");
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

/** A cue whose Companion button the last reconcile could not find. */
const missing = (over: Partial<StubRule> = {}): StubRule => ({
  id: "rule-1",
  name: "Projectors ON",
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name: "projectors_on", says: "the projectors" } },
  conditions: [],
  action: {
    id: "companion.press",
    params: {
      page: 1,
      row: 0,
      col: 1,
      pageId: "page-one",
      label: "Projectors ON",
      actionIds: "a1",
      status: "missing",
      lastSeenAt: "2026-09-01T09:00:00.000Z",
      movedFrom: "",
    },
  },
  cooldownSec: 0,
  oncePerService: false,
  ...over,
});

/** The pill's own status, from its attribute rather than from the node. */
const pill = (): string =>
  document.querySelector("[data-cue-button-status]")?.getAttribute("data-cue-button-status") ??
  "none";

/** Everything the pill's wrapper says, as one string. */
const pillText = (): string =>
  document.querySelector("[data-cue-button-status]")?.textContent?.trim() ?? "";

beforeEach(() => {
  RULES = [missing()];
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

describe("the rules list row", () => {
  test("shows the button-missing pill for a cue whose button is gone", async () => {
    await mount();
    assert.equal(pill(), "button missing");
    assert.match(pillText(), /button missing/);
    // And it names the button, because "missing" alone is not actionable.
    assert.match(pillText(), /Projectors ON is no longer on Companion page 1/);
  });

  test("shows the moved pill, with where it went", async () => {
    RULES = [
      missing({
        action: {
          id: "companion.press",
          params: {
            page: 1,
            row: 4,
            col: 6,
            pageId: "page-one",
            label: "Projectors ON",
            actionIds: "a1",
            status: "moved",
            lastSeenAt: "2026-09-09T13:00:00.000Z",
            movedFrom: "p1 r0 c1",
          },
        },
      }),
    ];
    await mount();
    assert.equal(pill(), "moved");
    assert.match(pillText(), /r0c1 → r4c6/);
  });

  test("shows NOTHING for a rule whose action is not a Companion press", async () => {
    RULES = [missing({ action: { id: "log.message", params: { message: "x", status: "missing" } } })];
    await mount();
    // `status: "missing"` is deliberately left in the params: readFingerprint
    // would read it happily, so the guard is on the action id, not on the shape
    // of what it holds.
    assert.equal(pill(), "none", "a non-Companion rule got a Companion pill");
  });

  test("shows nothing for a press rule that has never been reconciled", async () => {
    RULES = [
      missing({
        action: { id: "companion.press", params: { page: 1, row: 0, col: 1, label: "Projectors ON" } },
      }),
    ];
    await mount();
    assert.equal(pill(), "none", "an upgraded install got a pill on every cue");
  });
});
