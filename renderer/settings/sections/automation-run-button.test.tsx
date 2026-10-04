// The Run button on a rule's row, and the editor's Test going through the same
// server path.
//
// Run fires the action once, now, through POST /api/automation/rules/:id/run. The
// row says what happened under its summary, in one of three tones; a rule marked
// confirm-before-running turns the button into "Run it?" for five seconds first;
// and while the panic switch is on the button is disabled.
//
// NOT unit-tested here, and driven in a browser instead: that the tones read as
// green, amber and red, that the button sits at the row's right edge and wraps
// under a narrow name, and that the armed button reads as the warn tone.
// jsdom loads no stylesheet and reports every offsetHeight as 0.
//
// Nothing below passes a DOM node as an assert operand: node:assert inspects it
// on failure and a live jsdom element does not terminate in useful time.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

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
  confirmRequired?: boolean;
}

const REGISTRY = {
  triggers: [{ id: "pco.service-started", label: "A service starts", channel: "pco:live", params: [] }],
  conditions: [],
  actions: [{ id: "log.message", label: "Write a log message", params: [] }],
};

const rule = (over: Partial<StubRule> = {}): StubRule => ({
  id: "rule-1",
  name: "Doors",
  enabled: true,
  trigger: { id: "pco.service-started", params: {} },
  conditions: [],
  action: { id: "log.message", params: { message: "x" } },
  cooldownSec: 0,
  oncePerService: false,
  ...over,
});

let RULES: StubRule[] = [];
let DISARMED = false;
let requests: { method: string; url: string; body: string | null }[] = [];
/** What POST .../run answers with. */
let RUN: { status: number; body: unknown } = { status: 200, body: { outcome: "fired", detail: "x" } };

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  let status = 200;
  let body: unknown = {};
  if (method === "POST" && url.endsWith("/run")) {
    requests.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    status = RUN.status;
    body = RUN.body;
  } else if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES.map((r) => ({ ...r, issues: [] })), settings: { simulate: false, disarmed: DISARMED } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  else if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: [] };
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
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

const runButton = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>("[data-run-button]");
const runState = (): string => runButton()?.getAttribute("data-run-button") ?? "none";
const resultTone = (): string =>
  document.querySelector("[data-run-result]")?.getAttribute("data-run-result") ?? "none";
const resultText = (): string => document.querySelector("[data-run-result]")?.textContent?.trim() ?? "";
const runs = () => requests.filter((r) => r.url.endsWith("/run"));

async function press() {
  fireEvent.click(runButton()!);
  await settle();
}

beforeEach(() => {
  RULES = [rule()];
  DISARMED = false;
  requests = [];
  RUN = { status: 200, body: { outcome: "fired", detail: "x" } };
});
afterEach(async () => {
  mock.timers.reset();
  cleanup();
  client?.clear();
  await settle();
});
after(async () => {
  cleanup();
  await settle();
  teardown();
});

describe("Run on the rules list", () => {
  test("every rule row has one, and pressing it posts to the run route", async () => {
    RULES = [rule(), rule({ id: "rule-2", name: "Lights", enabled: false })];
    await mount();
    assert.equal(document.querySelectorAll("[data-run-button]").length, 2, "a disabled rule can be run too");
    await press();
    assert.deepEqual(
      runs().map((r) => r.url.split("/").slice(-2).join("/")),
      ["rule-1/run"],
    );
    assert.deepEqual(JSON.parse(runs()[0]!.body ?? "{}"), { confirmed: false });
  });

  test("done reads as the ok tone, with the time", async () => {
    await mount();
    await press();
    assert.equal(resultTone(), "fired");
    assert.match(resultText(), /^Run by hand at .*\d:\d\d:\d\d.* · done$/);
  });

  test("simulated reads as the warn tone, and says nothing was sent", async () => {
    RUN = { status: 200, body: { outcome: "simulated", detail: "x" } };
    await mount();
    await press();
    assert.equal(resultTone(), "simulated");
    assert.match(resultText(), /^Simulated at .*\d:\d\d:\d\d.* · nothing was sent$/);
  });

  test("a failed action reads as the danger tone, with its reason", async () => {
    RUN = { status: 200, body: { outcome: "failed", detail: "the timer is idle" } };
    await mount();
    await press();
    assert.equal(resultTone(), "failed");
    assert.match(resultText(), / · failed: the timer is idle$/);
  });

  test("a refusal from the server reads as failed, with the server's reason", async () => {
    RUN = { status: 409, body: { error: "Automation is disarmed, so nothing will run" } };
    await mount();
    await press();
    assert.equal(resultTone(), "failed");
    assert.match(resultText(), /failed: Automation is disarmed/);
  });

  test("the result stays until the next run replaces it", async () => {
    await mount();
    await press();
    assert.equal(resultTone(), "fired");
    RUN = { status: 200, body: { outcome: "failed", detail: "boom" } };
    await press();
    assert.equal(resultTone(), "failed");
    assert.equal(document.querySelectorAll("[data-run-result]").length, 1);
  });

  test("is disabled while disarmed, and pressing it sends nothing", async () => {
    DISARMED = true;
    await mount();
    assert.equal(runButton()?.disabled, true);
    await press();
    assert.deepEqual(runs(), []);
  });
});

describe("a rule marked confirm before running", () => {
  beforeEach(() => {
    RULES = [rule({ confirmRequired: true })];
  });

  test("the row says Confirm first, and says Off for a switched-off rule", async () => {
    RULES = [rule({ confirmRequired: true, enabled: false })];
    await mount();
    const pills = [...document.querySelectorAll("[data-rule-pill]")].map((p) => p.getAttribute("data-rule-pill"));
    assert.deepEqual(pills.sort(), ["confirm", "off"]);
  });

  test("the first press asks, and sends nothing", async () => {
    await mount();
    await press();
    assert.equal(runState(), "armed");
    assert.match(runButton()?.textContent ?? "", /Run it\?/);
    assert.deepEqual(runs(), []);
  });

  test("the second press runs it, with confirmed", async () => {
    await mount();
    await press();
    await press();
    assert.equal(runs().length, 1);
    assert.deepEqual(JSON.parse(runs()[0]!.body ?? "{}"), { confirmed: true });
    assert.equal(runState(), "idle");
  });

  test("the question lapses after five seconds", async () => {
    await mount();
    // settle() waits on setTimeout, so it cannot run while the clock is faked:
    // the press is one synchronous act and the ticks are the only waiting.
    mock.timers.enable({ apis: ["setTimeout"] });
    act(() => {
      fireEvent.click(runButton()!);
    });
    assert.equal(runState(), "armed");
    await act(async () => {
      mock.timers.tick(4999);
    });
    assert.equal(runState(), "armed", "lapsed early");
    await act(async () => {
      mock.timers.tick(1);
    });
    assert.equal(runState(), "idle");
    assert.deepEqual(runs(), []);
  });
});

describe("a pair's row", () => {
  const half = (which: "on" | "off", over: Partial<StubRule> = {}): StubRule =>
    rule({
      id: `rule-${which}`,
      name: `Projectors ${which.toUpperCase()}`,
      trigger: { id: "call.by-name", params: { name: `projectors_${which}`, says: "the projectors" } },
      ...over,
    });
  const button = (id: string): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(`[data-run-button][data-run-rule="${id}"]`);
  const click = async (id: string) => {
    fireEvent.click(button(id)!);
    await settle();
  };

  beforeEach(() => {
    RULES = [half("on"), half("off")];
  });

  test("is ONE row with one Run per half, labelled by the half", async () => {
    await mount();
    assert.equal(document.querySelectorAll("[data-cue-pair-row]").length, 1);
    assert.equal(document.querySelectorAll("[data-run-button]").length, 2);
    assert.match(button("rule-on")?.textContent ?? "", /Run on/);
    assert.match(button("rule-off")?.textContent ?? "", /Run off/);
  });

  test("each button runs its own rule, and the result names the half", async () => {
    await mount();
    await click("rule-off");
    assert.deepEqual(
      runs().map((r) => r.url.split("/").at(-2)),
      ["rule-off"],
    );
    await click("rule-on");
    assert.deepEqual(
      runs().map((r) => r.url.split("/").at(-2)),
      ["rule-off", "rule-on"],
    );
    const lines = [...document.querySelectorAll("[data-run-half]")].map((n) => n.textContent ?? "");
    assert.equal(lines.length, 2);
    assert.match(lines.find((l) => l.startsWith("On:")) ?? "", /^On: Run by hand at .* · done$/);
    assert.match(lines.find((l) => l.startsWith("Off:")) ?? "", /^Off: Run by hand at .* · done$/);
  });

  test("confirming one half does not arm the other", async () => {
    RULES = [half("on", { confirmRequired: true }), half("off")];
    await mount();
    await click("rule-on");
    assert.equal(button("rule-on")?.getAttribute("data-run-button"), "armed");
    assert.equal(button("rule-off")?.getAttribute("data-run-button"), "idle");
    assert.deepEqual(runs(), []);
    // The other half is not a confirm rule: one press runs it, and the armed
    // half stays armed.
    await click("rule-off");
    assert.equal(runs().length, 1);
    assert.equal(button("rule-on")?.getAttribute("data-run-button"), "armed");
    await click("rule-on");
    assert.deepEqual(JSON.parse(runs()[1]!.body ?? "{}"), { confirmed: true });
  });

  test("both are disabled while disarmed", async () => {
    DISARMED = true;
    await mount();
    assert.equal(button("rule-on")?.disabled, true);
    assert.equal(button("rule-off")?.disabled, true);
  });
});
