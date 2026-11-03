// Simulate and Disarm all write through one setSettings. A refused or unreachable write
// used to be an unhandled rejection: no toast, no log line, and the switch stayed where
// the operator left it. Now it toasts, logs a tagged line, and re-reads the settings.
//
// Nothing below passes a DOM node as an assert operand.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

let FAIL_SETTINGS = true;
let requests: { method: string; url: string; body: string | null }[] = [];
const REGISTRY = { triggers: [], conditions: [], actions: [] };

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  requests.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
  let status = 200;
  let body: unknown = {};
  if (method === "POST" && url.endsWith("/api/automation/settings")) {
    if (FAIL_SETTINGS) {
      status = 500;
      body = { error: "disk full" };
    }
  } else if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) body = { rules: [], settings: { simulate: false, disarmed: false } };
  else if (url.includes("/api/automation/log")) body = { entries: [] };
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

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");
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
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, { tab: "rules" }), React.createElement(Toaster)),
    ),
  );
  await settle();
}

const toasts = (): string => [...document.querySelectorAll(".text-footnote")].map((e) => e.textContent ?? "").join(" | ");
const ruleReads = () => requests.filter((r) => r.method === "GET" && r.url.includes("/api/automation/rules")).length;

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

describe("a refused settings write", () => {
  for (const [name, press, toastRe, key] of [
    ["Disarm all", () => fireEvent.click(screen.getByRole("button", { name: /Disarm all/ })), /Could not change the disarm switch: disk full/, "disarmed"],
    ["Simulate", () => fireEvent.click(screen.getByLabelText("Simulate mode")), /Could not change Simulate mode: disk full/, "simulate"],
  ] as const) {
    test(`${name} toasts, logs a tagged line and re-reads`, async () => {
      FAIL_SETTINGS = true;
      requests = [];
      await mount();
      const readsBefore = ruleReads();
      press();
      await settle();
      assert.match(toasts(), toastRe);
      const log = requests.find((r) => r.url.endsWith("/api/log/client"));
      assert.ok(log, "nothing reached /log");
      const line = JSON.parse(log.body ?? "{}") as { tag: string; message: string };
      assert.equal(line.tag, "automation");
      assert.match(line.message, new RegExp(`${key}.*disk full`));
      assert.ok(ruleReads() > readsBefore, "the switches were not re-read");
    });
  }
});
