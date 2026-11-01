// "Used on" chips and "Belongs to a button", on the Commands tab.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - A COMMAND THAT NOTHING USES SAYS SO, and one whose usage has not been read
//    says nothing at all. "nothing yet" over a usage that simply is not in is a
//    claim the page cannot back, and it is what a failed read would otherwise draw.
//  - A PAIR IS USED BY ITS BASE. A Button stores the pair's base, so a pair
//    looked up by `projectors_on` alone would read "nothing yet" over a Button
//    that sits on three consoles.
//  - A RULE A BUTTON MADE FOR ITSELF IS NOT IN THE COMMAND LIST. It is under
//    Belongs to a button, collapsed, where a removed Button is marked and the
//    row offers Delete: a rule is never deleted for the operator, so the row is
//    the only place its Button's absence is said.
//  - LIST IT WITH THE OTHER COMMANDS RELEASES THE RULE (`ownedBy: null`), and
//    nothing else changes on it.
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
  ownerMissing?: boolean;
}
type Use = { viewId: string; viewName: string; objectId: string; label: string; home: boolean };

const CALL = "call.by-name";
const REGISTRY = {
  triggers: [{ id: CALL, label: "Called by name (voice or HTTP)", channel: "cue:call", params: [{ key: "name", label: "Command name", type: "string" }] }],
  conditions: [],
  actions: [
    { id: "companion.press", label: "Press a Companion button", params: [] },
    { id: "log.message", label: "Write a log message", params: [] },
  ],
};

let RULES: StubRule[] = [];
let USAGE: Record<string, Use[]> | "fail" = {};
let requests: { method: string; url: string; body: string | null }[] = [];
/** The lines the page sent to /api/log/client. */
let logged: { tag: string; message: string }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  let status = 200;
  let body: unknown = {};
  if (url.includes("/api/log/client")) logged.push(JSON.parse(String(init?.body ?? "{}")));
  else if (method !== "GET") {
    // Only the writes this page makes: the SSE subscribe POST is the harness's own.
    if (url.includes("/api/automation/")) requests.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    if (!url.includes("/api/automation/")) body = {};
    else if (method === "DELETE") RULES = RULES.filter((r) => !url.endsWith(`/${r.id}`));
    if (method === "PATCH") body = { ...RULES.find((r) => url.endsWith(`/${r.id}`)), issues: [] };
  } else if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES.map((r) => ({ ...r, issues: [] })), settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/cues/usage")) {
    if (USAGE === "fail") {
      status = 503;
      body = { error: "views.json could not be read" };
    } else body = USAGE;
  } else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  return { ok: status < 400, status, statusText: String(status), json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
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
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, { tab: "commands" }), React.createElement(ConfirmHost, {})),
    ),
  );
  await settle();
}
async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `nothing to press: ${what}`);
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}
const button = (text: string): HTMLButtonElement | null =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) ?? null;

const cue = (name: string, over: Partial<StubRule> = {}, params: Record<string, string | number> = {}): StubRule => ({
  id: `rule-${name}`,
  name: `Rule ${name}`,
  enabled: true,
  trigger: { id: CALL, params: { name, ...params } },
  conditions: [],
  action: { id: "log.message", params: {} },
  cooldownSec: 0,
  oncePerService: false,
  ...over,
});
const use = (viewName: string, objectId = "o1", label = ""): Use => ({ viewId: `v-${viewName}`, viewName, objectId, label, home: viewName === "Home" });

/** The Used on line under a row, as text; null when the row has none. */
function usedOn(rowName: string): string | null {
  const row =
    document.querySelector(`[data-cue-pair-row="${rowName}"]`) ??
    document.querySelector(`[data-rule-name="${rowName}"]`)?.closest("[data-rule-row]");
  assert.ok(row, `no row ${rowName}`);
  return row.querySelector("[data-used-on]")?.textContent ?? null;
}
const ownedRows = () => [...document.querySelectorAll("[data-owned-rule]")].map((r) => r.getAttribute("data-owned-rule"));

beforeEach(() => {
  RULES = [];
  USAGE = {};
  requests = [];
  logged = [];
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

describe("Used on", () => {
  test("lists each screen a command's Buttons are on, once, and says nothing yet for none", async () => {
    RULES = [cue("take_screens"), cue("house_lights")];
    USAGE = { take_screens: [use("Booth console", "o1"), use("Booth console", "o2"), use("Home", "o3")] };
    await mount();
    assert.equal(usedOn("Rule take_screens"), "Used onBooth consoleHome");
    assert.equal(usedOn("Rule house_lights"), "Used onnothing yet");
  });

  test("a pair is used by its base, whichever half a Button names", async () => {
    RULES = [cue("projectors_on"), cue("projectors_off")];
    USAGE = { projectors: [use("FOH iPad")], projectors_off: [use("Booth console", "o9")] };
    await mount();
    assert.equal(usedOn("projectors"), "Used onFOH iPadBooth console");
  });

  test("a command is found through a former name a Button still names", async () => {
    RULES = [cue("take_screens", {}, { aliases: "old_screens" })];
    USAGE = { old_screens: [use("Booth console")] };
    await mount();
    assert.equal(usedOn("Rule take_screens"), "Used onBooth console");
  });

  test("a usage that could not be read draws no chips and says why, rather than reading as unused", async () => {
    RULES = [cue("take_screens")];
    USAGE = "fail";
    await mount();
    assert.equal(usedOn("Rule take_screens"), null, "a command read as unused over a failed read");
    assert.match(document.querySelector("[data-cue-usage-error]")?.textContent ?? "", /could not be read/);
    assert.ok(
      logged.some((l) => l.tag === "automation" && /could not read where each command is used/.test(l.message)),
      `the failed read never reached /log: ${JSON.stringify(logged)}`,
    );
  });

  test("a rule with another trigger has no Used on line: it is not a command", async () => {
    RULES = [cue("take_screens")];
    await mount();
    assert.equal(document.querySelectorAll("[data-used-on]").length, 1);
  });
});

describe("Belongs to a button", () => {
  const held = (name: string) => cue(name, { ownedBy: { viewId: "v-Booth console", objectId: "o1" } });

  test("a rule a Button made for itself is not in the command list, and the disclosure starts closed", async () => {
    RULES = [cue("take_screens"), held("btn_shutter")];
    USAGE = { btn_shutter: [use("Booth console", "o1", "Shutter")] };
    await mount();
    assert.deepEqual(
      [...document.querySelectorAll("[data-rule-name]")].map((e) => e.getAttribute("data-rule-name")),
      ["Rule take_screens"],
    );
    const details = document.querySelector("[data-belongs-to-button]") as HTMLDetailsElement;
    assert.ok(details, "no Belongs to a button disclosure");
    assert.equal(details.open, false);
    assert.deepEqual(ownedRows(), ["rule-btn_shutter"]);
  });

  test("with none owned the disclosure is not drawn at all", async () => {
    RULES = [cue("take_screens")];
    await mount();
    assert.equal(document.querySelector("[data-belongs-to-button]"), null);
  });

  test("a held row names its screen and Button and offers no Delete", async () => {
    RULES = [held("btn_shutter")];
    USAGE = { btn_shutter: [use("Booth console", "o1", "Shutter")] };
    await mount();
    const row = document.querySelector('[data-owned-rule="rule-btn_shutter"]');
    assert.match(row?.textContent ?? "", /Belongs to Booth console · Shutter/);
    assert.equal(row?.querySelector("[data-owner-state]")?.getAttribute("data-owner-state"), "held");
    assert.equal(button("Delete"), null);
  });

  test("a rule whose Button is gone says Button removed, and Delete asks, then deletes it", async () => {
    RULES = [{ ...held("btn_shutter"), ownerMissing: true }];
    await mount();
    const row = document.querySelector('[data-owned-rule="rule-btn_shutter"]');
    assert.equal(row?.querySelector("[data-owner-state]")?.getAttribute("data-owner-state"), "removed");
    assert.match(row?.textContent ?? "", /Button removed/);
    await press(button("Delete"), "Delete");
    assert.equal(requests.length, 0, "Delete wrote before it asked");
    // Two buttons read Delete now: the row's, and the confirm's, which is last in the DOM.
    await press([...document.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "Delete").at(-1), "the confirm's Delete");
    assert.deepEqual(
      requests.map((r) => `${r.method} ${r.url.split("/").slice(-2).join("/")}`),
      ["DELETE rules/rule-btn_shutter"],
    );
  });

  test("a rule whose Button now presses another command says so, not Button removed", async () => {
    RULES = [{ ...held("btn_shutter"), ownerMissing: true }];
    USAGE = { other_command: [use("Booth console", "o1", "Shutter")] };
    await mount();
    const row = document.querySelector('[data-owned-rule="rule-btn_shutter"]');
    assert.equal(row?.querySelector("[data-owner-state]")?.getAttribute("data-owner-state"), "repointed");
    assert.match(row?.textContent ?? "", /No longer used by its button/);
    assert.ok(button("Delete"), "a row that lost its Button offers no Delete");
  });

  test("List it with the other commands releases the rule, and writes nothing else", async () => {
    RULES = [held("btn_shutter")];
    USAGE = { btn_shutter: [use("Booth console", "o1", "Shutter")] };
    await mount();
    await press(button("List it with the other commands"), "List it");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "PATCH");
    assert.deepEqual(JSON.parse(requests[0]!.body ?? "{}"), { ownedBy: null });
  });
});
