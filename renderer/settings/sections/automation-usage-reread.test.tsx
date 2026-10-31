// When where-a-command-is-used is read again.
//
// Used on and Belongs to a button come from GET /api/cues/usage, which the server works
// out from the views file on every request. So the page must read it again when it can
// have changed, and not otherwise:
//
//  - WHEN A VIEW CHANGES, by this page, the layout editor or another client: the stage
//    state carries every view's revision and name, and a change to either re-reads the
//    usage after a short pause, so a burst of saves is one read. The first state is the
//    baseline, not a change. Without this, a chip said "nothing yet" over a Button
//    somebody had just added, and an owned rule read "held" over a Button just deleted.
//  - AFTER A WRITE OF THE PAGE'S OWN (an enable switch, a rename, Delete): the rules
//    and the usage, because a save can rename a command and its Buttons with it.
//  - NOT ON A RULES BROADCAST. A rules event says nothing about a layout, and reading a
//    file for every rule event, for as long as the page is open, is cost for no news.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");

const CALL = "call.by-name";
const RULE = {
  id: "r1",
  name: "Take screens",
  enabled: true,
  trigger: { id: CALL, params: { name: "take_screens" } },
  conditions: [],
  action: { id: "log.message", params: {} },
  cooldownSec: 0,
  oncePerService: false,
};
const REGISTRY = {
  triggers: [{ id: CALL, label: "Called by name (voice or HTTP)", channel: "cue:call", params: [{ key: "name", label: "Cue name", type: "string" }] }],
  conditions: [],
  actions: [{ id: "log.message", label: "Write a log message", params: [] }],
};

let reads: string[] = [];
const count = (path: string) => reads.filter((p) => p === path).length;
let VIEWS: { id: string; name: string; layoutRev?: number }[] = [];
const stage = () => ({ ...DEFAULT_STAGE_STATE, views: VIEWS });

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const path = String(url).split("?")[0]!;
  if (path === "/api/events/subscribe") return reply({});
  if ((init?.method ?? "GET") === "GET") reads.push(path);
  if (path === "/api/state") return reply(stage());
  if (path === "/api/automation/registry") return reply(REGISTRY);
  if (path === "/api/automation/rules") {
    return reply((init?.method ?? "GET") === "PATCH" ? { ...RULE, issues: [] } : { rules: [{ ...RULE, issues: [] }], settings: { simulate: true, disarmed: false } });
  }
  if (path === "/api/automation/log") return reply({ entries: [] });
  if (path === "/api/cues/usage") return reply({});
  if (path === "/api/cues/tokens") return reply({ tokens: [] });
  return reply({});
};
function reply(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
}

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { AutomationSection, VIEWS_REREAD_MS } = await import("./automation-section.js");
const { __resetForTests: resetStage } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

let client: InstanceType<typeof QueryClient> | null = null;
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, { tab: "commands" })),
    ),
  );
  for (let i = 0; i < 4; i++) await settle();
}
const pause = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const push = (channel: string, payload: unknown) =>
  act(async () => {
    FakeEventSource.last!.push(channel, payload);
    await settle();
  });

beforeEach(() => {
  reads = [];
  VIEWS = [{ id: "booth", name: "Booth", layoutRev: 1 }];
  resetStage();
  __resetReplayCacheForTests();
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

describe("where commands are used is read again", () => {
  test("once on arrival, and the first stage state is a baseline and not a change", async () => {
    await mount();
    await pause(VIEWS_REREAD_MS + 150);
    assert.equal(count("/api/cues/usage"), 1);
  });

  test("when a view's revision changes, after a pause, and a burst of saves is one read", async () => {
    await mount();
    for (const rev of [2, 3, 4]) {
      VIEWS = [{ id: "booth", name: "Booth", layoutRev: rev }];
      await push("stage:state-changed", stage());
      await pause(100);
    }
    assert.equal(count("/api/cues/usage"), 1, "read before the pause was over");
    await eventually(() => assert.equal(count("/api/cues/usage"), 2), 3000);
    await pause(VIEWS_REREAD_MS + 150);
    assert.equal(count("/api/cues/usage"), 2, "a burst of three saves was read more than once");
  });

  test("when a view is renamed, added or removed", async () => {
    await mount();
    VIEWS = [{ id: "booth", name: "Booth console", layoutRev: 1 }];
    await push("stage:state-changed", stage());
    await eventually(() => assert.equal(count("/api/cues/usage"), 2), 3000);
    VIEWS = [...VIEWS, { id: "foh", name: "FOH", layoutRev: 0 }];
    await push("stage:state-changed", stage());
    await eventually(() => assert.equal(count("/api/cues/usage"), 3), 3000);
    VIEWS = [];
    await push("stage:state-changed", stage());
    await eventually(() => assert.equal(count("/api/cues/usage"), 4), 3000);
  });

  test("not for a stage state that changed nothing about the views", async () => {
    await mount();
    await push("stage:state-changed", { ...stage(), planTitle: "Another plan" });
    await pause(VIEWS_REREAD_MS + 150);
    assert.equal(count("/api/cues/usage"), 1);
  });

  test("not on a rules broadcast, which says nothing about a layout", async () => {
    await mount();
    const rulesBefore = count("/api/automation/rules");
    await push("automation:rules", {});
    await eventually(() => assert.ok(count("/api/automation/rules") > rulesBefore, "the rules were not re-read"));
    await pause(VIEWS_REREAD_MS + 150);
    assert.equal(count("/api/cues/usage"), 1, "a rules event read the views file");
  });

  test("after a write of the page's own: the rules and the usage both", async () => {
    await mount();
    const rulesBefore = count("/api/automation/rules");
    const sw = document.querySelector('[data-rule-name="Take screens"]')?.closest("[data-rule-row]")?.querySelector('button[role="switch"]');
    assert.ok(sw, "no enable switch");
    await act(async () => {
      fireEvent.click(sw as HTMLElement);
    });
    await eventually(() => assert.equal(count("/api/cues/usage"), 2, "a write of the page's own did not re-read the usage"));
    assert.ok(count("/api/automation/rules") > rulesBefore);
  });
});
