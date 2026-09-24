// The rules-list "Needs setup" badge and the switch's refusal over it — the
// List.dc.html board of the validation-canvas mockup.
//
// The list reads `issues` straight off GET /api/automation/rules (computed by
// the server against the current registry, never stored) — see
// automation-routes.ts and automation-param-validation.ts. This file is the
// wiring: that a rule with issues shows the badge and a rule without one does
// not, and that trying to switch a broken rule ON is refused WITHOUT a round
// trip, with the exact toast List.dc.html shows.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see
// automation-rule-row.test.tsx for why.
//
// NOT unit-tested here, and driven in a browser instead: that the badge reads
// amber. jsdom loads no stylesheet, so a colour is not observable in it.

import assert from "node:assert/strict";
import { mock } from "node:test";
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

/** A trigger with a required "meter" string and a required "threshold"
 *  number, and an action with a required "targetId" enum — real registry
 *  shapes (spl.crossed-above, rosstalk.command), not a stub invention. */
const REGISTRY = {
  triggers: [
    { id: CALL_TRIGGER_ID, label: "Called by name (voice or HTTP)", channel: "cue:call", params: [{ key: "name", label: "Cue name", type: "string" }] },
    {
      id: "spl.crossed-above",
      label: "SPL rises above",
      channel: "spl:metrics",
      params: [
        { key: "meter", label: "Meter", type: "string" },
        { key: "threshold", label: "Threshold (dB)", type: "number", min: 0, max: 140 },
      ],
    },
  ],
  conditions: [],
  actions: [
    {
      id: "rosstalk.command",
      label: "Send a RossTalk command",
      params: [{ key: "targetId", label: "Target", type: "enum", optionsFrom: "rosstalk-targets" }],
    },
    { id: "log.message", label: "Write a log message", params: [{ key: "message", label: "Message", type: "string" }] },
  ],
};

let RULES: StubRule[] = [];
let requests: { method: string; url: string }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (method !== "GET") requests.push({ method, url });
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    // The list's own read: issues computed the SAME way the server does, so
    // this stub is a faithful stand-in rather than a hand-picked flag.
    body = { rules: RULES.map((r) => ({ ...r, issues: issuesFor(r) })), settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

/** A minimal stand-in for ruleIssues, over the same two rules this file uses —
 *  not imported from the real module, because this is a RENDERER test and the
 *  real validator's own correctness is proven in
 *  automation-param-validation.test.ts. This just has to agree with what a
 *  real server would say about these two specific rules. */
function issuesFor(r: StubRule): { key: string; message: string; step: string; label: string }[] {
  const out: { key: string; message: string; step: string; label: string }[] = [];
  if (r.trigger.id === "spl.crossed-above") {
    if (!String(r.trigger.params.meter ?? "").trim()) {
      out.push({ step: "trigger", key: "meter", label: "Meter", message: "Required" });
    }
  }
  if (r.action.id === "rosstalk.command") {
    if (!String(r.action.params.targetId ?? "").trim()) {
      out.push({ step: "action", key: "targetId", label: "Target", message: "Pick a target" });
    }
  }
  return out;
}

const needsSetup = (over: Partial<StubRule> = {}): StubRule => ({
  id: "rule-spl",
  name: "SPL alarm cue",
  enabled: false,
  trigger: { id: "spl.crossed-above", params: { threshold: 95 } }, // meter missing
  conditions: [],
  action: { id: "rosstalk.command", params: {} }, // targetId missing
  cooldownSec: 0,
  oncePerService: false,
  ...over,
});

const clean = (over: Partial<StubRule> = {}): StubRule => ({
  id: "rule-clean",
  name: "Walk-in music",
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name: "walk_in" } },
  conditions: [],
  action: { id: "log.message", params: { message: "cue" } },
  cooldownSec: 0,
  oncePerService: false,
  ...over,
});

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { toast } = await import("../../components/ui/toast.js");
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
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, {})),
    ),
  );
  await settle();
}

const badge = (): HTMLElement | null => document.querySelector("[data-needs-setup]");
const switchFor = (name: string): HTMLButtonElement | null =>
  document.querySelector(`[data-rule-name="${name}"]`)?.closest(".rounded-lg")?.querySelector('button[role="switch"]') ?? null;

beforeEach(() => {
  RULES = [];
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

describe("the Needs setup badge", () => {
  test("a rule with issues shows it, naming the fields", async () => {
    RULES = [needsSetup()];
    await mount();
    const b = badge();
    assert.ok(b, "no badge rendered for a rule with issues");
    assert.match(b!.textContent ?? "", /Needs setup: 2 fields/);
    assert.match(b!.getAttribute("title") ?? "", /Meter/);
    assert.match(b!.getAttribute("title") ?? "", /Target/);
  });

  test("a rule with no issues shows no badge at all", async () => {
    RULES = [clean()];
    await mount();
    assert.equal(badge(), null, "a clean rule got a Needs setup badge");
  });
});

describe("turning a needs-setup rule ON", () => {
  test("is refused without a round trip, with the toast List.dc.html shows", async () => {
    RULES = [needsSetup()];
    await mount();
    const errorSpy = mock.method(toast, "error");
    const sw = switchFor("SPL alarm cue");
    assert.ok(sw, "no switch rendered for the rule");
    await act(async () => {
      sw!.click();
    });
    await settle();
    assert.equal(requests.length, 0, "a refused enable must not even reach the server");
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.equal(
      errorSpy.mock.calls[0]?.arguments[0],
      'Can\'t turn on "SPL alarm cue": 2 fields need attention. Open it to fix them.',
    );
    errorSpy.mock.restore();
  });

  test("turning it OFF is never refused, issues or not", async () => {
    RULES = [needsSetup({ enabled: true })];
    await mount();
    const sw = switchFor("SPL alarm cue");
    await act(async () => {
      sw!.click();
    });
    await settle();
    // At least one PATCH, not exactly one: the section's own SSE reconnect can
    // trigger an incidental refetch in this harness independent of the click,
    // and that GET is not what this guard is about — see
    // renderer-test-and-browser-gotchas for the same SSE-timing class of noise.
    assert.ok(
      requests.some((r) => r.method === "PATCH" && r.url.endsWith("/rule-spl")),
      `turning a broken rule off must still reach the server, got ${JSON.stringify(requests)}`,
    );
  });

  test("a clean rule's switch is never blocked", async () => {
    RULES = [clean({ enabled: false })];
    await mount();
    const sw = switchFor("Walk-in music");
    await act(async () => {
      sw!.click();
    });
    await settle();
    assert.ok(
      requests.some((r) => r.method === "PATCH" && r.url.endsWith("/rule-clean")),
      `a clean rule's switch must reach the server, got ${JSON.stringify(requests)}`,
    );
  });
});
