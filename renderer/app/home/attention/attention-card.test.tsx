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
const { ACTION_NOTE_MS } = await import("../card-actions.js");
const { HomeEditing } = await import("../home-editing.js");
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } = await import("@tanstack/react-router");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
await router.load();

const OUTPUTS = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, name: `Screen ${i}`, viewId: "v" }));
const stateOf = (outputs: unknown[]) =>
  ({ pcoConfigured: true, planId: "p", views: [{ id: "home" }, { id: "a" }, { id: "b" }], outputs }) as unknown as StageState;

type Snooze = import("@main/types/home-snoozes").HomeSnooze;
type On = { interactive?: boolean; editing?: boolean; snooze?: (key: string, sev: string) => Promise<unknown>; unsnooze?: (key: string) => Promise<unknown> };

/** The card as a test draws it, so a test can draw it again with new input. */
function card(over: Parameters<typeof attentionInput>[0], snoozes: Snooze[] = [], on: On = {}) {
  return React.createElement(
    RouterContextProvider as never,
    { router },
    React.createElement(
      HomeEditing,
      { value: on.editing ?? false },
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

function view(over: Parameters<typeof attentionInput>[0], snoozes: Snooze[] = [], on: On = {}) {
  return render(card(over, snoozes, on));
}

// DOM nodes are compared with `assert.ok(a === b)`, never `assert.equal(a, b)`:
// on a failure assert.equal renders both nodes into its message, which takes
// 30-45s on a jsdom element and fails the whole file instead of the one test.
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
  const { container } = view({
    state: stateOf([OUTPUTS[0]]),
    onlineKnown: false, wirelessKnown: false, integrationsKnown: false,
    reaperKnown: false, obsKnown: false, resiKnown: false, youtubeKnown: false,
  });
  await settle();
  assert.ok(/Checking/.test(text(container)) && !/All clear/.test(text(container)));
});

test("every problem snoozed and nothing healthy is All clear, not Checking forever", async () => {
  const { container } = view(
    { mood: "live", minutesLeft: 52, state: stateOf([]), assigned: new Map([["rx::3", "Lead"]]),
      wireless: [mic("rx::3", { battery: 5, batteryMinutes: 3 })] },
    [
      { key: "wireless-battery:rx::3", severity: "critical", at: 0, expiresAt: null },
      { key: "readiness:assigned", severity: "warn", at: 0, expiresAt: null },
    ],
  );
  await settle();
  assert.ok(/All clear/.test(text(container)) && !/Checking/.test(text(container)), text(container));
});

test("the snooze list not having answered yet shows no problem, so a snoozed one cannot flash", async () => {
  const over = {
    mood: "live" as const, minutesLeft: 52, state: stateOf([]), assigned: new Map([["rx::3", "Lead"]]),
    wireless: [mic("rx::3", { battery: 5, batteryMinutes: 3 })],
  };
  const { container } = render(
    React.createElement(
      RouterContextProvider as never,
      { router },
      React.createElement(AttentionView, {
        input: attentionInput(over), snoozes: [], snoozesKnown: false, interactive: true,
        onSnooze: async () => {}, onUnsnooze: async () => {},
      }),
    ),
  );
  await settle();
  assert.equal(container.querySelectorAll("li").length, 0, text(container));
  assert.notEqual(mark(container), "critical", "no red edge before the snoozes are read");
});
test("off Home (a wall or console) the rows draw with no button of any kind", async () => {
  const { container } = view(
    {
      mood: "live", minutesLeft: 52, state: stateOf(OUTPUTS), onlineOutputIds: [],
      assigned: new Map([["rx::3", "Lead"]]), wireless: [mic("rx::3", { battery: 5, batteryMinutes: 3 })],
      integrations: [integration("reaper")], integrationLabels: { reaper: "REAPER" },
      reaper: { connected: true, recording: false, recordPaused: false, playing: false, positionSeconds: null, positionString: null },
    },
    [{ key: "screen-offline:o0", severity: "warn", at: 0, expiresAt: null }],
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
  assert.match(screen.getByRole("alert").textContent ?? "", /^Could not snooze .+: disk full$/);
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

test("more than three problems, box not measured yet: three rows and a '+N more' that opens the full list", async () => {
  const { container } = view({ mood: "idle", state: stateOf(OUTPUTS), onlineOutputIds: [] });
  await settle();
  assert.equal(container.querySelectorAll("li").length, 3);
  assert.ok(screen.queryByRole("dialog") === null, "no dialog");
  const more = screen.getByRole("button", { name: "+2 more" });
  fireEvent.click(more);
  await settle();
  const dialog = screen.getByRole("dialog", { name: "Needs attention" });
  // Every problem, not the three the card drew, each with its own Snooze.
  assert.equal(dialog.querySelectorAll("li").length, 5);
  assert.equal(dialog.querySelectorAll('button[aria-label^="Snooze"]').length, 5);
  // The card behind it still drew three rows and did not scroll.
  assert.equal(container.querySelectorAll("section > ul > li").length, 3);
  fireEvent.click(screen.getByRole("button", { name: "Close Needs attention" }));
  await settle();
  assert.ok(screen.queryByRole("dialog") === null, "no dialog");
  assert.ok(document.activeElement === more, "focus comes back to +N more");
});

test("Escape closes the full list", async () => {
  view({ mood: "idle", state: stateOf(OUTPUTS), onlineOutputIds: [] });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
  await settle();
  assert.ok(screen.getByRole("dialog"), "the list opened");
  fireEvent.keyDown(document, { key: "Escape" });
  await settle();
  assert.ok(screen.queryByRole("dialog") === null, "no dialog");
});

test("Snooze inside the full list snoozes that row", async () => {
  const calls: string[] = [];
  view({ mood: "idle", state: stateOf(OUTPUTS), onlineOutputIds: [] }, [], { snooze: async (k) => void calls.push(k) });
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
  await settle();
  const dialog = screen.getByRole("dialog");
  // The fifth row, one the card behind it never drew.
  fireEvent.click(dialog.querySelectorAll('button[aria-label^="Snooze"]')[4]!);
  await settle();
  assert.deepEqual(calls, ["screen-offline:o4"]);
});

test("'+N more' counts the problems left out, not the snoozed ones", async () => {
  // Five problems, one snoozed: four to show, three drawn, so one more. Counting
  // the snoozed one would say "+2 more" and open a list one short of it.
  const { container } = view(FIVE, [{ key: "screen-offline:o0", severity: "warn", at: 0, expiresAt: null }]);
  await settle();
  assert.equal(container.querySelectorAll("section > ul > li").length, 3);
  assert.ok(/\+1 more/.test(text(container)) && !/\+2 more/.test(text(container)), text(container));
  fireEvent.click(screen.getByRole("button", { name: "+1 more" }));
  await settle();
  assert.equal(screen.getByRole("dialog").querySelectorAll('button[aria-label^="Snooze"]').length, 4);
});

test("while Home is being arranged '+N more' is a count, so Tab cannot open the overlay under the editor", async () => {
  const { container } = view({ mood: "idle", state: stateOf(OUTPUTS), onlineOutputIds: [] }, [], { editing: true });
  await settle();
  assert.ok(/\+2 more/.test(text(container)), text(container));
  assert.ok(screen.queryByRole("button", { name: "+2 more" }) === null, "a control to Tab to while editing");
});

// The overlay grows out of the card (useExpand's FLIP starts from the section,
// which is its tileRef). Not tested here: jsdom has no layout, so the panel
// measures 0x0 and the FLIP returns before it moves anything. It is driven in a
// browser, reading the panel's transform as it opens.

test("off Home '+N more' stays a count, with no control and no overlay", async () => {
  const { container } = view({ mood: "idle", state: stateOf(OUTPUTS), onlineOutputIds: [] }, [], { interactive: false });
  await settle();
  assert.ok(/\+2 more/.test(text(container)));
  assert.equal(container.querySelectorAll("button").length, 0);
});

// jsdom reports every box as 0x0. What the card does at a SIZE is arithmetic over
// the box it measures, so these give the section a size by hand. What the result
// LOOKS like (nothing over anything, no scrollbar) is driven in a browser: jsdom
// loads no stylesheet, so no computed style says whether anything scrolls. The
// checks below read what the markup itself sets: the fixed heights, and the
// overflow classes and inline styles of every element in the card.
function inBox<T>(w: number, h: number, run: () => T): T {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => w });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => h });
  try {
    return run();
  } finally {
    delete (proto as Record<string, unknown>).clientWidth;
    delete (proto as Record<string, unknown>).clientHeight;
  }
}

/** The pixel heights the section's own children claim, in order. */
function claimedHeights(container: HTMLElement): number[] {
  const section = container.querySelector("section")!;
  const px = (e: Element) => parseFloat((e as HTMLElement).style.height);
  const out: number[] = [];
  for (const child of Array.from(section.children)) {
    if (child.tagName === "UL") for (const li of Array.from(child.children)) out.push(px(li));
    else if (!Number.isNaN(px(child))) out.push(px(child));
  }
  return out;
}

/** Every element in the card, the card included, that its markup lets scroll or
 *  stick. The overlay is portalled to <body>, outside the card, and may scroll. */
function scrollers(container: HTMLElement): string[] {
  const section = container.querySelector("section")!;
  const SCROLLS = /(^|\s)(overflow(-[xy])?-(auto|scroll)|sticky)(\s|$)/;
  return [section, ...Array.from(section.querySelectorAll<HTMLElement>("*"))]
    .filter((e) => {
      const st = (e as HTMLElement).style;
      return SCROLLS.test(e.getAttribute("class") ?? "") ||
        /auto|scroll/.test(`${st.overflow} ${st.overflowX} ${st.overflowY}`) || st.position === "sticky";
    })
    .map((e) => `${e.tagName.toLowerCase()}.${e.getAttribute("class") ?? ""}`);
}

const FIVE = { mood: "idle" as const, state: stateOf(OUTPUTS), onlineOutputIds: [] as string[] };

test("Home's XL box with five problems shows whole rows that fit, then '+N more', and claims no more than the box", async () => {
  const { container } = inBox(1160, 252, () => view(FIVE));
  await settle();
  const rows = container.querySelectorAll("li").length;
  const claimed = claimedHeights(container).reduce((a, b) => a + b, 0);
  assert.ok(rows >= 1 && rows < 5, `rows ${rows}`);
  assert.ok(new RegExp(`\\+${5 - rows} more`).test(text(container)), text(container));
  assert.ok(claimed <= 252, `children claim ${claimed}px of a 252px box`);
  assert.deepEqual(scrollers(container), [], "a widget does not scroll");
});

test("a small box: fewer rows, the healthy line gives way before the list does, and it still claims no more than the box", async () => {
  const sizes = [[420, 200], [420, 150], [420, 120], [420, 90], [420, 40]];
  const seen: number[] = [];
  for (const [w, h] of sizes) {
    const { container, unmount } = inBox(w, h, () => view(FIVE));
    await settle();
    seen.push(container.querySelectorAll("li").length);
    const claimed = claimedHeights(container).reduce((a, b) => a + b, 0);
    // A box too short for even the header cannot hold anything; the header is the floor.
    assert.ok(claimed <= Math.max(h, 32), `${w}x${h}: children claim ${claimed}px`);
    assert.deepEqual(scrollers(container), [], `${w}x${h}: a widget does not scroll`);
    unmount();
  }
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a), `rows never grow as the box shrinks: ${seen}`);
  assert.equal(seen[seen.length - 1], 0, "a box with no room for a row draws the header alone");
});

test("'Show 1 snoozed' opens the snoozed row even when the problems already fill the box", async () => {
  // Home's XL tile with five problems and one snoozed: the problems took every
  // row, so the snoozed one was cut and the toggle opened nothing.
  const calls: string[] = [];
  const { container } = inBox(1160, 252, () =>
    view(FIVE, [{ key: "screen-offline:o0", severity: "warn", at: 0, expiresAt: null }], { unsnooze: async (k) => void calls.push(k) }),
  );
  await settle();
  const keys = (await import("./collect.js")).collectAttention(attentionInput(FIVE)).map((i) => i.key);
  assert.ok(keys.includes("screen-offline:o0"), `fixture has no screen-offline:o0 item: ${keys.join(",")}`);
  assert.ok(screen.queryByRole("button", { name: /^Unsnooze/ }) === null, "an Unsnooze before the list is open");
  fireEvent.click(screen.getByRole("button", { name: "Show 1 snoozed" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: /^Unsnooze/ }));
  await settle();
  assert.deepEqual(calls, ["screen-offline:o0"]);
  assert.ok(claimedHeights(container).reduce((a, b) => a + b, 0) <= 252, "still inside the box");
});

test("buttons go compact, then to the fix alone, then away, as the box narrows", async () => {
  const at = async (w: number) => {
    const { container, unmount } = inBox(w, 400, () => view({ ...FIVE, mood: "idle" }));
    await settle();
    const snooze = container.querySelectorAll('button[aria-label^="Snooze"]').length;
    const small = container.querySelectorAll("li button.h-6, li a.h-6").length;
    const any = container.querySelectorAll("li button, li a").length;
    unmount();
    return { snooze: snooze > 0, small: small > 0, any: any > 0 };
  };
  assert.deepEqual(await at(600), { snooze: true, small: false, any: true });
  assert.deepEqual(await at(380), { snooze: true, small: true, any: true });
  assert.deepEqual(await at(280), { snooze: false, small: true, any: true });
  assert.deepEqual(await at(200), { snooze: false, small: false, any: false });
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

test("a failed fix's note clears itself", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, detail: "x", simulated: true }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const { mock } = await import("node:test");
  try {
    view({
      mood: "live", state: stateOf([OUTPUTS[0]]), onlineOutputIds: ["o0"],
      integrations: [integration("reaper")], integrationLabels: { reaper: "REAPER" },
      reaper: { connected: true, recording: false, recordPaused: false, playing: false, positionSeconds: null, positionString: null },
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    // Mocked setTimeout would stall settle(); flush the promise chain by hand.
    const { act } = await import("@testing-library/react");
    await act(async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); });
    assert.match(screen.getByRole("alert").textContent ?? "", /Start recording failed/);
    act(() => mock.timers.tick(ACTION_NOTE_MS));
    assert.ok(screen.queryByRole("alert") === null, "the note must not outlive its moment");
  } finally {
    mock.timers.reset();
    globalThis.fetch = orig;
  }
});

// A screen offline, snoozed at the severity it is shown at outside a service.
const snoozedScreen = (i: number): Snooze => ({ key: `screen-offline:o${i}`, severity: "warn", at: 0, expiresAt: null });

test("the snoozed list opened in a one-row box has a Hide, even with no room for the strip", async () => {
  // Every problem snoozed in a one-row Home card: the all-clear tile offers
  // "Show 5 snoozed", and the list it opens is the header, one row and "+4
  // more". Hide lived only in the strip, which that box has no room for, so the
  // list stayed open with no way back.
  const all = [0, 1, 2, 3, 4].map(snoozedScreen);
  const { container } = inBox(420, 120, () => view(FIVE, all));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show 5 snoozed" }));
  await settle();
  assert.ok(/Snoozed · 5/.test(text(container)), text(container));
  assert.ok(/\+4 more/.test(text(container)), text(container));
  assert.deepEqual(scrollers(container), [], "the snoozed list does not scroll either");
  fireEvent.click(screen.getByRole("button", { name: "Hide snoozed" }));
  await settle();
  assert.ok(screen.queryByRole("button", { name: /^Unsnooze/ }) === null, `still open: ${text(container)}`);
  assert.ok(/All clear/.test(text(container)), text(container));
});

test("the snoozed list opened from the strip keeps a Hide when the strip gives way", async () => {
  // One problem and four snoozed at 120px: the strip fits beside the one
  // problem, and holds Show; the list it opens has no room for the strip.
  const { container } = inBox(420, 120, () => view(FIVE, [0, 1, 2, 3].map(snoozedScreen)));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show 4 snoozed" }));
  await settle();
  assert.ok(/Snoozed · 4/.test(text(container)), text(container));
  fireEvent.click(screen.getByRole("button", { name: "Hide snoozed" }));
  await settle();
  assert.ok(/Needs attention · 1/.test(text(container)), text(container));
});

test("a NEW problem closes the snoozed list; an Unsnooze inside it does not", async () => {
  const four = { mood: "idle" as const, state: stateOf(OUTPUTS.slice(0, 4)), onlineOutputIds: [] as string[] };
  const snoozes = [0, 1, 2, 3].map(snoozedScreen);
  const { container, rerender } = view(four, snoozes);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show 4 snoozed" }));
  await settle();
  assert.ok(/Snoozed · 4/.test(text(container)), text(container));
  // One unsnoozed (here, or on another device): it was in the list, so the list stays.
  rerender(card(four, snoozes.slice(1)));
  await settle();
  assert.ok(/Snoozed · 3/.test(text(container)), `closed on an Unsnooze: ${text(container)}`);
  // A fifth screen goes offline: the card shows it, not the list it would hide behind.
  rerender(card(FIVE, snoozes.slice(1)));
  await settle();
  assert.ok(/Needs attention · 2/.test(text(container)), `a new problem left behind the list: ${text(container)}`);
  assert.ok(screen.queryByRole("button", { name: /^Unsnooze/ }) === null, text(container));
});

test("'+N more' under the snoozed list opens the full list on the snoozed rows", async () => {
  // Five snoozed, one row's room: the card shows one and "+4 more" of them, so
  // the overlay must open on those five, not on the problems with them folded.
  const { container } = inBox(420, 120, () => view(FIVE, [0, 1, 2, 3, 4].map(snoozedScreen)));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show 5 snoozed" }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "+4 more" }));
  await settle();
  const dialog = screen.getByRole("dialog", { name: "Needs attention" });
  assert.equal(dialog.querySelectorAll('button[aria-label^="Unsnooze"]').length, 5, dialog.textContent ?? "");
  assert.ok(/Snoozed · 5/.test(text(container)), "the card behind it is still on the snoozed list");
});

test("a snoozed problem that gets worse closes the snoozed list", async () => {
  // Three screens snoozed outside a service, two at warn and one at critical.
  // The service starts and an offline screen is critical while live: the two
  // snoozed at warn show again with their snoozes still held, the third stays
  // snoozed, so the list is not emptied. The keys are ones the list already had,
  // so "is it a key we had" cannot see it.
  const idle = { mood: "idle" as const, state: stateOf(OUTPUTS.slice(0, 3)), onlineOutputIds: [] as string[] };
  const live = { ...idle, mood: "live" as const, minutesLeft: 52 };
  const { collectAttention } = await import("./collect.js");
  const keys = (o: Parameters<typeof attentionInput>[0]) => collectAttention(attentionInput(o)).map((i) => `${i.key} ${i.severity}`);
  assert.deepEqual(keys(idle), ["screen-offline:o0 warn", "screen-offline:o1 warn", "screen-offline:o2 warn"], "fixture");
  assert.deepEqual(
    keys(live),
    ["screen-offline:o0 critical", "screen-offline:o1 critical", "screen-offline:o2 critical"],
    "fixture: the same keys, worse",
  );
  const snoozes: Snooze[] = [snoozedScreen(0), snoozedScreen(1), { ...snoozedScreen(2), severity: "critical" }];
  const { container, rerender } = view(idle, snoozes);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show 3 snoozed" }));
  await settle();
  assert.ok(/Snoozed · 3/.test(text(container)), text(container));
  rerender(card(live, snoozes));
  await settle();
  assert.ok(/Needs attention · 2/.test(text(container)), `a worse problem left behind the list: ${text(container)}`);
  assert.ok(/Show 1 snoozed/.test(text(container)), text(container));
});

// Where the note sits on the all-clear tile (in the caption's place, at its type
// size, so "All clear" does not move while it shows) is not tested here: jsdom
// loads no stylesheet and lays nothing out, so a note that grows and pushes the
// headline down reads the same as one that does not. It was checked in a
// browser, comparing the headline's position with and without a note.

test("a failed Snooze in a one-row card keeps its row and '+N more'", async () => {
  // 118px: the header, one row and "+N more" are 112px. A note on a line of its
  // own took the row's place, and the row and "+N more" were gone until a
  // later Snooze happened to succeed.
  const { container } = inBox(420, 118, () => view(FIVE, [], { snooze: async () => { throw new Error("disk full"); } }));
  await settle();
  fireEvent.click(screen.getAllByRole("button", { name: /^Snooze/ })[0]!);
  await settle();
  // It names the problem it could not snooze, not "that".
  assert.equal(screen.getByRole("alert").textContent, "Could not snooze Screen 0 is offline: disk full");
  assert.equal(container.querySelectorAll("section > ul > li").length, 1, text(container));
  assert.ok(screen.queryByRole("button", { name: "+4 more" }) !== null, `no +N more: ${text(container)}`);
  assert.ok(claimedHeights(container).reduce((a, b) => a + b, 0) <= 118, "still inside the box");
});

test("a failed Unsnooze in a one-row card leaves All clear and its Show N snoozed", async () => {
  const { container } = inBox(420, 118, () =>
    view(FIVE, [0, 1, 2, 3, 4].map(snoozedScreen), { unsnooze: async () => { throw new Error("disk full"); } }),
  );
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show 5 snoozed" }));
  await settle();
  fireEvent.click(screen.getAllByRole("button", { name: /^Unsnooze/ })[0]!);
  await settle();
  assert.equal(screen.getByRole("alert").textContent, "Could not unsnooze Screen 0 is offline: disk full");
  assert.equal(container.querySelectorAll("section > ul > li").length, 1, `the list lost its row: ${text(container)}`);
  fireEvent.click(screen.getByRole("button", { name: "Hide snoozed" }));
  await settle();
  assert.ok(/All clear/.test(text(container)), text(container));
  assert.ok(screen.queryByRole("button", { name: "Show 5 snoozed" }) !== null, `no way back to the list: ${text(container)}`);
});

test("a problem already showing that gets worse closes the snoozed list", async () => {
  // Idle: Screen 0 shows at warn, Screen 1 is snoozed at critical. The service
  // starts: Screen 0 turns critical while it was showing, so its key was in the
  // card when the list opened, and Screen 1 stays snoozed, so the list is not
  // emptied. Only the rise in severity can see it.
  const idle = { mood: "idle" as const, state: stateOf(OUTPUTS.slice(0, 2)), onlineOutputIds: [] as string[] };
  const live = { ...idle, mood: "live" as const, minutesLeft: 52 };
  const snoozes: Snooze[] = [{ ...snoozedScreen(1), severity: "critical" }];
  const { container, rerender } = view(idle, snoozes);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show 1 snoozed" }));
  await settle();
  assert.ok(/Snoozed · 1/.test(text(container)), text(container));
  rerender(card(live, snoozes));
  await settle();
  assert.equal(mark(container), "critical");
  assert.ok(/Needs attention · 1/.test(text(container)), `a worse problem left behind the list: ${text(container)}`);
});

test("the snoozed list emptied by Unsnooze does not spring open at the next snooze", async () => {
  const four = { mood: "idle" as const, state: stateOf(OUTPUTS.slice(0, 4)), onlineOutputIds: [] as string[] };
  const { container, rerender } = view(four, [snoozedScreen(0)]);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Show 1 snoozed" }));
  await settle();
  assert.ok(/Snoozed · 1/.test(text(container)), text(container));
  rerender(card(four, []));
  await settle();
  assert.ok(/Needs attention · 4/.test(text(container)), text(container));
  // Somebody snoozes another problem, here or on another device.
  rerender(card(four, [snoozedScreen(2)]));
  await settle();
  assert.ok(/Needs attention · 3/.test(text(container)), `the list opened by itself: ${text(container)}`);
});

test("the all-clear tile offers Show N snoozed from its threshold height, not below it", async () => {
  const all = [0, 1, 2, 3, 4].map(snoozedScreen);
  const offered = async (h: number) => {
    const { unmount } = inBox(420, h, () => view(FIVE, all));
    await settle();
    const yes = screen.queryByRole("button", { name: "Show 5 snoozed" }) !== null;
    unmount();
    return yes;
  };
  assert.deepEqual([await offered(111), await offered(112)], [false, true]);
});
