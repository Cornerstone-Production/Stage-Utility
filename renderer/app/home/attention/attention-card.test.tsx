// The widget, drawn over a given input: rows, the healthy line, snooze, and the
// states a Home can be in. jsdom loads no stylesheet and reports every height as
// 0, so what the tile LOOKS like (the ring, the short list leaving the tile's own
// ground below it) is driven in a browser, not here.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";
import { attentionInput, integration, mic } from "./test-input.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { AttentionView } = await import("./attention-card.js");
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } = await import("@tanstack/react-router");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
await router.load();

const OUTPUTS = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, name: `Screen ${i}`, viewId: "v" }));
const stateOf = (outputs: unknown[]) =>
  ({ pcoConfigured: true, planId: "p", views: [{ id: "home" }, { id: "a" }, { id: "b" }], outputs }) as unknown as StageState;

function view(
  over: Parameters<typeof attentionInput>[0],
  snoozes: import("@main/types/home-snoozes").HomeSnooze[] = [],
  on: { interactive?: boolean; snooze?: (key: string, sev: string) => Promise<unknown>; unsnooze?: (key: string) => Promise<unknown> } = {},
) {
  return render(
    React.createElement(
      RouterContextProvider as never,
      { router },
      React.createElement(AttentionView, {
        input: attentionInput(over),
        snoozes,
        interactive: on.interactive ?? true,
        onSnooze: (i: { key: string; severity: string }) => (on.snooze ?? (async () => {}))(i.key, i.severity),
        onUnsnooze: on.unsnooze ?? (async () => {}),
      }),
    ),
  );
}

const text = (c: HTMLElement) => c.textContent ?? "";
const mark = (c: HTMLElement) => c.querySelector("[data-attention]")?.getAttribute("data-attention");

test("nothing wrong: a captioned tile that says All clear, with the healthy entries beneath and no list", async () => {
  const { container } = view({ state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"] });
  await settle();
  assert.equal(mark(container), "clear");
  assert.equal(container.querySelector("h2")?.textContent, "Needs attention", "captioned like the cards beside it");
  assert.ok(/All clear/.test(text(container)), text(container));
  assert.ok(/1 of 1 screens/.test(text(container)), text(container));
  assert.equal(container.querySelectorAll("li").length, 0);
});

test("nothing heard yet is Checking, not All clear", async () => {
  const { container } = view({ state: stateOf([OUTPUTS[0]]), onlineKnown: false, wirelessKnown: false, integrationsKnown: false });
  await settle();
  assert.ok(/Checking/.test(text(container)) && !/All clear/.test(text(container)));
});

test("off Home (a wall or console) the rows draw with no button of any kind", async () => {
  const { container } = view(
    {
      mood: "live", minutesLeft: 52, state: stateOf(OUTPUTS), onlineOutputIds: [],
      assigned: new Map([["rx::3", "Lead"]]), wireless: [mic("rx::3", { battery: 5, batteryMinutes: 3 })],
      integrations: [integration("reaper")], integrationLabels: { reaper: "REAPER" },
      reaper: { connected: true, recording: false, recordPaused: false, playing: false, positionSeconds: null, positionString: null },
    },
    [{ key: "readiness:plan", severity: "warn", at: 0, expiresAt: null }],
    { interactive: false },
  );
  await settle();
  assert.ok(container.querySelectorAll("li").length >= 3, "the problems are still drawn");
  assert.ok(/\+\d+ more/.test(text(container)), "the count of what is hidden is still said");
  assert.equal(container.querySelectorAll("button, a").length, 0, `controls on a wall: ${text(container)}`);
});

test("the all-clear tile off Home has no Show snoozed button either", async () => {
  const { container } = view(
    { state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"], mood: "live", minutesLeft: 52, assigned: new Map([["rx::3", "L"]]), wireless: [mic("rx::3", { battery: 5, batteryMinutes: 3 })] },
    [{ key: "wireless-battery:rx::3", severity: "critical", at: 0, expiresAt: null }],
    { interactive: false },
  );
  await settle();
  assert.equal(container.querySelectorAll("button").length, 0);
});

test("a problem: its title, reason, Snooze and fix; critical marks the tile critical", async () => {
  const { container } = view({
    mood: "live", minutesLeft: 52,
    state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"],
    assigned: new Map([["rx::3", "Worship lead"]]),
    wireless: [mic("rx::3", { name: "Handheld 3", battery: 19, batteryMinutes: 40 })],
  });
  await settle();
  const t = text(container);
  assert.ok(/Needs attention · 1/.test(t), t);
  assert.ok(/Handheld 3 at 19%/.test(t));
  assert.ok(/about 40 min left, service has 52 to go/.test(t));
  assert.ok(/all else healthy/.test(t));
  assert.equal(mark(container), "critical");
  assert.equal(screen.getByRole("link", { name: "Open slots" }).getAttribute("href"), "/mic-slots");
});

test("Snooze asks the server for THIS key at THIS severity", async () => {
  const calls: string[] = [];
  view(
    { mood: "live", minutesLeft: 52, state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"],
      assigned: new Map([["rx::3", "Lead"]]), wireless: [mic("rx::3", { battery: 5, batteryMinutes: 3 })] },
    [], { snooze: async (k, s) => void calls.push(`${k} ${s}`) },
  );
  fireEvent.click(screen.getByRole("button", { name: /^Snooze/ }));
  await settle();
  assert.deepEqual(calls, ["wireless-battery:rx::3 critical"]);
});

test("a failed Snooze says so, in words, in the tile", async () => {
  view(
    { mood: "live", minutesLeft: 52, state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"],
      assigned: new Map([["rx::3", "Lead"]]), wireless: [mic("rx::3", { battery: 5, batteryMinutes: 3 })] },
    [], { snooze: async () => { throw new Error("disk full"); } },
  );
  fireEvent.click(screen.getByRole("button", { name: /^Snooze/ }));
  await settle();
  assert.match(screen.getByRole("alert").textContent ?? "", /Could not snooze that: disk full/);
});

test("a snoozed item is hidden, offered back under 'Show 1 snoozed', and Unsnooze says which key", async () => {
  const calls: string[] = [];
  const { container } = view(
    { mood: "live", minutesLeft: 52, state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"],
      assigned: new Map([["rx::3", "Lead"]]), wireless: [mic("rx::3", { name: "HH3", battery: 5, batteryMinutes: 3 })] },
    [{ key: "wireless-battery:rx::3", severity: "critical", at: 0, expiresAt: null }],
    { unsnooze: async (k) => void calls.push(k) },
  );
  assert.equal(mark(container), "clear", "the only problem is snoozed");
  assert.ok(!/Needs attention ·/.test(text(container)));
  fireEvent.click(screen.getByRole("button", { name: "Show 1 snoozed" }));
  fireEvent.click(screen.getByRole("button", { name: /^Unsnooze/ }));
  await settle();
  assert.deepEqual(calls, ["wireless-battery:rx::3"]);
});

test("a snooze made at warn does not hide the same mic once it is critical", async () => {
  const { container } = view(
    { mood: "live", minutesLeft: 52, state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"],
      assigned: new Map([["rx::3", "Lead"]]), wireless: [mic("rx::3", { battery: 5, batteryMinutes: 3 })] },
    [{ key: "wireless-battery:rx::3", severity: "warn", at: 0, expiresAt: null }],
  );
  assert.equal(mark(container), "critical");
});

test("more than three problems: three rows and '+N more', which expands in place", async () => {
  const { container } = view({ mood: "idle", state: stateOf(OUTPUTS), onlineOutputIds: [] });
  await settle();
  assert.equal(container.querySelectorAll("li").length, 3);
  fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
  assert.equal(container.querySelectorAll("li").length, 5);
  fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  assert.equal(container.querySelectorAll("li").length, 3);
});

// What the stubbed command route answers the next press.
let answer: Record<string, unknown> = { ok: true, detail: "record" };
let answerStatus = 200;

test("an in-place fix (Start recording) presses its command and does not navigate", async () => {
  const posted: unknown[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).includes("/api/cues/")) posted.push(String(url).slice(String(url).lastIndexOf("/") + 1));
    void init;
    return new Response(JSON.stringify(answer), { status: answerStatus, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    view({
      mood: "live", state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"],
      integrations: [integration("reaper")], integrationLabels: { reaper: "REAPER" },
      reaper: { connected: true, recording: false, recordPaused: false, playing: false, positionSeconds: null, positionString: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    assert.deepEqual(posted, ["reaper_record_on"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("a Start recording that Simulate stops says so on the card", async () => {
  const posted: unknown[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).includes("/api/cues/")) posted.push(String(url).slice(String(url).lastIndexOf("/") + 1));
    void init;
    return new Response(JSON.stringify(answer), { status: answerStatus, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  answer = { ok: true, detail: "would send record", simulated: true };
  try {
    view({
      mood: "live", state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"],
      integrations: [integration("reaper")], integrationLabels: { reaper: "REAPER" },
      reaper: { connected: true, recording: false, recordPaused: false, playing: false, positionSeconds: null, positionString: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await settle();
    assert.deepEqual(posted, ["reaper_record_on"]);
    assert.match(screen.getByRole("alert").textContent ?? "", /Start recording failed: Simulated: nothing was sent/);
  } finally {
    globalThis.fetch = orig;
    answer = { ok: true, detail: "record" };
  }
});
