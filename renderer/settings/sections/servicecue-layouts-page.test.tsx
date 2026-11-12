// servicecue-layouts-page.test.tsx — the ServiceCue layouts page, driven through the real
// section over a server that saves by the store's own rules (test-fixtures/servicecue-server).
//
// What is under test is what an operator can be misled by or stuck at: a section that is
// not there to use, a control that saves the wrong thing, a confirm that names the wrong
// layouts.
//
// NOT unit-tested here, and driven in a browser instead (jsdom loads no stylesheet and lays
// nothing out): the 260px cap on the preview and its inner scroll, the drop marker's place,
// the drag ghost, touch, focus staying on a grip as its item is redrawn (jsdom never blurs
// a moved node), and how the page looks beside the mockup at 1280 and 390.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see servicecue-section-reads.test.tsx.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { serviceCueServer } from "../../test-fixtures/servicecue-server.js";
import { alerts, reply } from "../../test-fixtures/fetch-log.js";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const React = await import("react");
const { ServiceCueSection } = await import("./servicecue-section.js");
const { TooltipProvider, ConfirmHost } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const TYPES = [{ id: "sun", name: "Sunday Morning" }, { id: "wed", name: "Wednesday Night" }, { id: "yth", name: "Youth" }];
const ROLES = [
  { id: "r-audio", name: "Audio", members: ["Audio", "Sound"] },
  { id: "r-light", name: "Lighting", members: ["Lighting", "Lights"] },
  { id: "r-band", name: "Band", members: ["Band"] },
];
const LAYOUTS: ServiceCueLayout[] = [
  { id: "l-audio", name: "Audio", order: 0, columnRoles: ["r-audio", "r-band"], showMaxSpl: true },
  { id: "l-light", name: "Lighting", order: 1, columnRoles: ["r-light"], rowColor: "category", accentRole: "r-light" },
];

async function mount(): Promise<void> {
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
      React.createElement(TooltipProvider, null, React.createElement(ServiceCueSection), React.createElement(ConfirmHost)),
    ),
  );
  for (let i = 0; i < 5; i++) await settle();
}

/** How many saves went to `path`. Only the page's own: the event stream's subscribe is a POST too. */
const saves = (s: { requests: { method: string; path: string }[] }, path: string) =>
  s.requests.filter((r) => r.method === "POST" && r.path === path).length;

const headings = () => [...document.querySelectorAll("h1, h2")].map((h) => h.textContent ?? "");
const rowHeads = () =>
  [...document.querySelectorAll("button[aria-expanded]")]
    .filter((b) => /^(Landing page|Public link)/.test(b.textContent ?? ""))
    .map((b) => `${b.textContent} ${b.getAttribute("aria-expanded")}`);

test("the page: its title, a way back, and the sections in order", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun", "wed"], types: TYPES });
  try {
    await mount();
    assert.deepEqual(headings(), ["ServiceCue layouts", "Layouts", "Category roles"]);
    assert.equal(screen.getByRole("link", { name: "ServiceCue" }).getAttribute("href"), "/servicecue/manage");
    // The two rows a church sets once sit last, shut, each saying what it holds.
    await eventually(() =>
      assert.deepEqual(rowHeads(), ["Landing page· Sunday Morning, Wednesday Night false", "Public link· Off false"]),
    );
  } finally {
    s.restore();
  }
});

test("Category roles is there to use before any layout exists", async () => {
  // It used to be drawn only once a layout existed, while a new layout's columns
  // come from roles: nothing on the page could be set up first.
  const s = serviceCueServer({ roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await eventually(() => assert.equal(!!screen.queryByText(/No layouts yet/i), true));
    assert.deepEqual(headings(), ["ServiceCue layouts", "Layouts", "Category roles"]);
    assert.equal(!!screen.queryByDisplayValue("Lighting"), true, "the roles are listed with no layout");
  } finally {
    s.restore();
  }
});

// ── Landing page and Public link rows ───────────────────────────────────────

test("Public link opens to the card without a frame or a title of its own: the row has both", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    fireEvent.click(await eventually(() => screen.getByRole("button", { name: /^Public link/ })));
    const card = await eventually(() => document.querySelector('section[aria-labelledby="pub-title"]') as HTMLElement);
    assert.equal(card.querySelector("h2")?.classList.contains("sr-only"), true, "a second visible Public link title inside the row");
    assert.equal(/\bborder\b/.test(card.className), false, `a card frame inside the row's own: ${card.className}`);
  } finally {
    s.restore();
  }
});

test("the shut Public link row keeps its summary current", async () => {
  const { usePublishSummary } = await import("./servicecue-public-link.js");
  let enabled = false;
  const s = serviceCueServer({
    override: (url) => (url.includes("/api/servicecue/publish")
      ? { ok: true, status: 200, json: async () => ({ enabled, url: "https://x.example.org", token: "", status: { state: "ok" }, deploy: {} }), text: async () => "" }
      : undefined),
  });
  function Summary() {
    return React.createElement("span", { "data-summary": true }, usePublishSummary(40));
  }
  try {
    render(React.createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) }, React.createElement(Summary)));
    await eventually(() => assert.equal(document.querySelector("[data-summary]")?.textContent, "Off"));
    enabled = true;
    await eventually(() => assert.equal(document.querySelector("[data-summary]")?.textContent, "Publishing", "the summary never read again"), 2000);
  } finally {
    s.restore();
  }
});

test("Landing page opens to the service types, and a tick saves them in Planning Center's order", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["wed"], types: TYPES });
  try {
    await mount();
    fireEvent.click(await eventually(() => screen.getByRole("button", { name: /^Landing page/ })));
    await settle();
    fireEvent.click(screen.getByRole("checkbox", { name: "Sunday Morning" }));
    await eventually(() => assert.deepEqual(s.shown(), ["sun", "wed"]));
    await eventually(() => assert.deepEqual(rowHeads(), ["Landing page· Sunday Morning, Wednesday Night true", "Public link· Off false"]));
  } finally {
    s.restore();
  }
});

// ── Layout cards ────────────────────────────────────────────────────────────

/** Open a layout's card by its shut header, which is named for the layout and its columns. */
async function openCard(name: string): Promise<void> {
  fireEvent.click(await eventually(() => screen.getByRole("button", { name: new RegExp(`^${name},`) })));
  await settle();
}
const openCards = () => [...document.querySelectorAll('input[aria-label="Layout name"]')].map((n) => (n as HTMLInputElement).value);

test("a shut card lists every column it draws, in the rundown's order", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await eventually(() => screen.getByRole("button", { name: "Audio, Clock · Time · Item · Audio · Band · Max SPL" }));
    screen.getByRole("button", { name: "Lighting, Clock · Time · Item · Lighting" });
  } finally {
    s.restore();
  }
});

test("one card is open at a time", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    assert.deepEqual(openCards(), ["Audio"]);
    await openCard("Lighting");
    assert.deepEqual(openCards(), ["Lighting"]);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Lighting" }));
    await settle();
    assert.deepEqual(openCards(), []);
  } finally {
    s.restore();
  }
});

test("New layout starts with no roles, Clock and Time on and Max SPL off, open and ready to name", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    fireEvent.click(await eventually(() => screen.getByRole("button", { name: /New layout/ })));
    await eventually(() => assert.equal(s.layouts().length, 3));
    const made = s.layouts()[2];
    assert.deepEqual(
      { name: made.name, columnRoles: made.columnRoles, showClock: made.showClock, showLength: made.showLength, showMaxSpl: made.showMaxSpl },
      { name: "Layout 3", columnRoles: [], showClock: undefined, showLength: undefined, showMaxSpl: false },
    );
    await eventually(() => assert.deepEqual(openCards(), ["Layout 3"]));
    const field = screen.getByDisplayValue("Layout 3") as HTMLInputElement;
    assert.equal(document.activeElement === field, true, "the new layout's name is not focused");
    assert.equal(field.selectionStart === 0 && field.selectionEnd === "Layout 3".length, true, "its name is not selected to type over");
  } finally {
    s.restore();
  }
});

test("Duplicate puts '<name> copy' right after it, under its own address, open to rename", async () => {
  const s = serviceCueServer({
    layouts: [...LAYOUTS, { id: "l-copy", name: "Audio copy", order: 2, columnRoles: [] }],
    roles: ROLES,
    shown: ["sun"],
    types: TYPES,
  });
  try {
    await mount();
    await openCard("Audio");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Audio" }));
    await eventually(() => assert.equal(s.layouts().length, 4));
    const stored = s.layouts();
    assert.deepEqual(stored.map((l) => l.name), ["Audio", "Audio copy 2", "Lighting", "Audio copy"]);
    const copy = stored[1];
    assert.deepEqual(copy.columnRoles, ["r-audio", "r-band"]);
    assert.equal(copy.showMaxSpl, true);
    assert.notEqual(copy.id, "l-audio");
    assert.equal(copy.slug, "audio-copy-2", "the copy took the original's address");
    await eventually(() => assert.deepEqual(openCards(), ["Audio copy 2"]));
    // Named by the page, not the operator: its first rename moves its address, as a new layout's does.
    const box = screen.getByRole("textbox", { name: "Layout name" }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "Monitors" } });
    fireEvent.blur(box);
    await eventually(() => assert.equal(s.layouts()[1].slug, "monitors", "renaming the copy kept its Audio copy 2 address"));
  } finally {
    s.restore();
  }
});

test("deleting a layout moves focus to the card that takes its place, else the one before, else New layout", async () => {
  const s = serviceCueServer({
    layouts: [...LAYOUTS, { id: "l-sm", name: "Stage manager", order: 2, columnRoles: [] }],
    roles: ROLES,
    shown: ["sun"],
    types: TYPES,
  });
  const remove = async (name: string) => {
    await openCard(name);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${name}` }));
    fireEvent.click(within(await eventually(() => screen.getByRole("alertdialog"))).getByRole("button", { name: "Delete layout" }));
    for (let i = 0; i < 4; i++) await settle();
  };
  const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "";
  try {
    await mount();
    await remove("Lighting");
    await eventually(() => assert.match(focused(), /^Stage manager,/, `focus is on "${focused()}"`));
    await remove("Stage manager");
    await eventually(() => assert.match(focused(), /^Audio,/, `focus is on "${focused()}"`));
    await remove("Audio");
    await eventually(() => assert.match(focused(), /New layout/, `focus is on "${focused()}"`));
  } finally {
    s.restore();
  }
});

test("Escape puts the name back and leaves the field, saving nothing", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    const box = screen.getByRole("textbox", { name: "Layout name" }) as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: "Monitors" } });
    fireEvent.keyDown(box, { key: "Escape" });
    for (let i = 0; i < 3; i++) await settle();
    assert.equal(box.value, "Audio");
    assert.equal(document.activeElement === box, false, "Escape did not leave the field");
    assert.equal(saves(s, "/api/servicecue/layouts"), 0, "the name thrown away was saved as Escape left the field");
  } finally {
    s.restore();
  }
});

test("a name typed, then Duplicate clicked: the rename saves and the copy carries the new name", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    const box = screen.getByRole("textbox", { name: "Layout name" }) as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: "Front desk" } });
    // A click on Duplicate blurs the field first.
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole("button", { name: /^Duplicate/ }));
    await eventually(() => assert.deepEqual(s.layouts().map((l) => l.name), ["Front desk", "Front desk copy", "Lighting"]));
  } finally {
    s.restore();
  }
});

// ── Columns, Not in this layout, Under the title, Footer ────────────────────

/** The Columns row as drawn, one entry per chip; a chip that can be removed ends in " x". */
const columnsRow = (layoutId: string) =>
  [...(document.querySelector(`[data-cols="${layoutId}"]`)?.children ?? [])].map((c) => {
    const x = c.querySelector('button[aria-label^="Remove"]') ? " x" : "";
    return `${c.textContent}${x}`;
  });
const trayRow = (layoutId: string) =>
  [...(document.querySelector(`[data-tray="${layoutId}"]`)?.querySelectorAll("button") ?? [])].map((b) => b.textContent ?? "");

const RUNDOWN = {
  serviceTypeId: "sun", planId: "p1", planTitle: "Sun 15 Nov", planSeriesTitle: null, planDates: null,
  items: [{ id: "i1", title: "Open the Gates", itemType: "song", lengthSec: 270, sequence: 0, notesByCategory: { Audio: "Click to band", Lighting: "Cue 12" }, description: null }],
  noteCategories: ["Audio", "Lighting"], serviceTimes: [], timeZone: null, isActivePlan: false, isDefaultPlan: true,
};
const CATS = { sun: ["Audio", "Lighting", "Band", "Graphics"], wed: ["Sound", "Lights"], yth: ["Audio"] };
const previewHeads = () => [...document.querySelectorAll("[data-preview] th")].map((th) => th.textContent ?? "");

test("the Columns row holds every column in the rundown's order; Item has no X", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    // The roles' left/right controls are named, so strip them to the chip's own words.
    const row = columnsRow("l-audio").map((c) => c.replace(/^Move .*?left|Move .*?right/g, ""));
    assert.deepEqual(row, ["Clock x", "Time x", "Item", "Audio x", "Band x", "Max SPL x"]);
    assert.deepEqual(trayRow("l-audio"), ["Lighting"], "what this layout lacks: every role it does not show");
  } finally {
    s.restore();
  }
});

test("removing a column sends it to Not in this layout, and clicking it there puts it back in its place", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    fireEvent.click(screen.getByRole("button", { name: "Remove Clock" }));
    await eventually(() => assert.equal(s.layouts()[0].showClock, false));
    assert.deepEqual(trayRow("l-audio"), ["Clock", "Lighting"], "Clock leads the tray, as it leads the row");
    assert.equal((document.activeElement as HTMLElement | null)?.getAttribute("aria-label"), "Add Clock", "focus fell off the removed chip");

    fireEvent.click(screen.getByRole("button", { name: "Add Lighting" }));
    await eventually(() => assert.deepEqual(s.layouts()[0].columnRoles, ["r-audio", "r-band", "r-light"]), undefined);
    assert.equal((document.activeElement as HTMLElement | null)?.getAttribute("aria-label"), "Remove Lighting");

    fireEvent.click(screen.getByRole("button", { name: "Add Clock" }));
    await eventually(() => assert.equal(s.layouts()[0].showClock, true));
    assert.equal(columnsRow("l-audio")[0], "Clock x", "Clock goes back to its fixed place, first");
    assert.deepEqual(trayRow("l-audio"), []);
    assert.match(document.querySelector('[data-tray="l-audio"]')?.textContent ?? "", /Every column is in this layout\./);
  } finally {
    s.restore();
  }
});

test("Max SPL, off on a layout saved without it, waits in the tray and goes in last", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Lighting");
    assert.deepEqual(trayRow("l-light"), ["Audio", "Band", "Max SPL"]);
    fireEvent.click(screen.getByRole("button", { name: "Add Max SPL" }));
    await eventually(() => assert.equal(s.layouts()[1].showMaxSpl, true));
    assert.equal(columnsRow("l-light").at(-1), "Max SPL x");
  } finally {
    s.restore();
  }
});

test("removing the column a layout tints rows by stops the tint", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Lighting");
    fireEvent.click(within(document.querySelector('[data-cols="l-light"]') as HTMLElement).getByRole("button", { name: "Remove Lighting" }));
    await eventually(() => assert.deepEqual(s.layouts()[1].columnRoles, []));
    assert.equal(s.layouts()[1].accentRole, null, "the layout still tints by a role it no longer shows");
  } finally {
    s.restore();
  }
});

test("Under the title and Footer: each toggle says whether it is on, saves, and redraws the preview", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, cats: CATS, rundown: () => RUNDOWN });
  try {
    await mount();
    await openCard("Audio");
    await eventually(() => assert.equal(!!document.querySelector("[data-preview] table"), true));
    const songKey = screen.getByRole("button", { name: "Song key", pressed: true });
    fireEvent.click(songKey);
    await eventually(() => assert.equal(s.layouts()[0].showKey, false));
    assert.equal(screen.getByRole("button", { name: "Song key" }).getAttribute("aria-pressed"), "false");
    assert.match(document.querySelector("[data-preview]")?.textContent ?? "", /total time/);
    fireEvent.click(screen.getByRole("button", { name: "Total time", pressed: true }));
    await eventually(() => assert.equal(s.layouts()[0].showTotalTime, false));
    assert.doesNotMatch(document.querySelector("[data-preview]")?.textContent ?? "", /total time/, "the footer is still drawn");
  } finally {
    s.restore();
  }
});

test("the preview follows the Columns row, and says which role the previewed type has no category for", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, cats: CATS, rundown: () => RUNDOWN });
  try {
    await mount();
    await openCard("Lighting");
    await eventually(() => assert.equal(previewHeads().includes("Lighting"), true, JSON.stringify(previewHeads())));
    fireEvent.click(screen.getByRole("button", { name: "Add Audio" }));
    await eventually(() => assert.equal(previewHeads().includes("Audio"), true, JSON.stringify(previewHeads())));
    // Youth names no lighting category: the column is left out, and the page says why.
    fireEvent.change(screen.getByRole("combobox", { name: "Preview with" }), { target: { value: "yth" } });
    await eventually(() => assert.match(document.body.textContent ?? "", /Lighting has no category in Youth, so the preview leaves it out\./));
  } finally {
    s.restore();
  }
});

// ── Drag: keyboard ──────────────────────────────────────────────────────────

/** A grip by what it moves: "the Audio layout", "the Audio column", "Sound in Audio". */
const grip = (what: string) => screen.getByRole("button", { name: `Move ${what}. Press Space to pick up` });
const press = async (el: Element, ...keys: string[]) => {
  for (const key of keys) {
    fireEvent.keyDown(el, { key });
    await settle();
  }
};
const said = () => document.querySelector("[data-announcer]")?.textContent ?? "";
const roleRow = (layoutId: string) =>
  [...(document.querySelector(`[data-cols="${layoutId}"]`)?.querySelectorAll("[data-sort-id]") ?? [])].map((c) => c.textContent ?? "");

test("keyboard: Space picks a role column up, the arrows move it with the preview, Space drops and saves once", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, cats: CATS, rundown: () => RUNDOWN });
  try {
    await mount();
    await openCard("Audio");
    await eventually(() => assert.equal(previewHeads().includes("Band"), true));
    const audio = grip("the Audio column");
    audio.focus();
    await press(audio, " ");
    assert.equal(audio.getAttribute("aria-pressed"), "true");
    await eventually(() => assert.match(said(), /Picked up Audio, position 1 of 2\. Arrow keys move it, Space drops it, Escape cancels\./));
    await press(audio, "ArrowRight");
    assert.deepEqual(roleRow("l-audio"), ["Band", "Audio"], "the row did not follow the arrow");
    const heads = previewHeads();
    assert.equal(heads.indexOf("Band") < heads.indexOf("Audio"), true, `the preview did not follow: ${JSON.stringify(heads)}`);
    // jsdom keeps focus on a node React moves, so this cannot fail on a grip that loses
    // it; a browser blurs it, which is why Grip refocuses. Checked in a browser.
    assert.equal(document.activeElement === grip("the Audio column"), true, "focus left the grip it was moving");
    assert.equal(saves(s, "/api/servicecue/layouts"), 0, "a move saved before it was dropped");
    await press(grip("the Audio column"), "ArrowRight");
    await eventually(() => assert.match(said(), /Audio is already last\./));
    await press(grip("the Audio column"), " ");
    await eventually(() => assert.deepEqual(s.layouts()[0].columnRoles, ["r-band", "r-audio"]));
    assert.equal(saves(s, "/api/servicecue/layouts"), 1, "one drop, one save");
    await eventually(() => assert.match(said(), /Dropped Audio at position 2 of 2\./));
  } finally {
    s.restore();
  }
});

test("keyboard: Escape puts the column back and saves nothing", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    const audio = grip("the Audio column");
    audio.focus();
    await press(audio, " ", "ArrowRight");
    assert.deepEqual(roleRow("l-audio"), ["Band", "Audio"]);
    await press(grip("the Audio column"), "Escape");
    assert.deepEqual(roleRow("l-audio"), ["Audio", "Band"]);
    await eventually(() => assert.match(said(), /Move cancelled\. Audio is back at position 1 of 2\./));
    for (let i = 0; i < 3; i++) await settle();
    assert.equal(saves(s, "/api/servicecue/layouts"), 0);
  } finally {
    s.restore();
  }
});

test("keyboard: a layout card moves up, and the new order is what the page reads back", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    const lighting = await eventually(() => grip("the Lighting layout"));
    lighting.focus();
    await press(lighting, " ", "ArrowUp", " ");
    await eventually(() => assert.deepEqual(s.layouts().map((l) => l.id), ["l-light", "l-audio"]));
    // As a reload would: a fresh page reads the order back from the server.
    cleanup();
    resetStageState();
    resetReplayCache();
    await mount();
    await eventually(() =>
      assert.deepEqual([...document.querySelectorAll("[data-layout-name]")].map((n) => n.textContent), ["Lighting", "Audio"]),
    );
  } finally {
    s.restore();
  }
});

test("keyboard: a role's categories reorder, first has priority", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    const sound = await eventually(() => grip("Sound in Audio"));
    sound.focus();
    await press(sound, " ", "ArrowLeft", " ");
    await eventually(() => assert.deepEqual(s.roles()[0].members, ["Sound", "Audio"]));
  } finally {
    s.restore();
  }
});

// ── Drag: pointer ───────────────────────────────────────────────────────────
//
// jsdom lays nothing out, so every rect is empty. `placeRects` gives the open card's
// Columns row and tray a rect each, and every chip in them one, from the DOM's own order:
// the row along y=0, the tray along y=60, each chip 80px wide with a 10px gap. That is
// all a drop needs; where the marker sits against the real chips is checked in a browser.

type Box = { x: number; y: number; w: number; h: number };
const rects = new WeakMap<Element, Box>();
const realRect = Element.prototype.getBoundingClientRect;
function placeRects(layoutId: string, dy = 0): void {
  const lay = (row: Element | null, y: number, chipSel: string) => {
    if (!row) return;
    rects.set(row, { x: 0, y, w: 900, h: 30 });
    [...row.querySelectorAll(chipSel)].forEach((c, i) => rects.set(c, { x: i * 90, y, w: 80, h: 30 }));
  };
  lay(document.querySelector(`[data-cols="${layoutId}"]`), dy, ":scope > *");
  lay(document.querySelector(`[data-tray="${layoutId}"]`), 60 + dy, ":scope > *");
  installRects();
}
/** The layout cards stacked 60px apart, and a role's categories in a row at y=300. */
function placeStack(roleId: string): void {
  const list = document.querySelector('[data-sort-list="layouts"]')!;
  rects.set(list, { x: 0, y: 0, w: 900, h: 200 });
  [...list.querySelectorAll("[data-layout-card]")].forEach((c, i) => rects.set(c, { x: 0, y: i * 60, w: 900, h: 50 }));
  const members = document.querySelector(`[data-members="${roleId}"]`)!;
  rects.set(members, { x: 0, y: 300, w: 900, h: 26 });
  [...members.querySelectorAll("[data-sort-id]")].forEach((c, i) => rects.set(c, { x: i * 90, y: 300, w: 80, h: 26 }));
  installRects();
}
function installRects(): void {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = rects.get(this) ?? (this.closest("[role=listitem]") ? rects.get(this.closest("[role=listitem]")!) : undefined);
    if (!r) return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} } as DOMRect;
    return { x: r.x, y: r.y, left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, toJSON() {} } as DOMRect;
  };
}
const centre = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** Press on `source`, carry it to (x, y), then let go there, or press Escape first. */
async function carry(source: Element, to: { x: number; y: number }, opts: { escape?: boolean; back?: boolean } = {}) {
  const s = centre(source);
  fireEvent.mouseDown(source, { button: 0, clientX: s.x, clientY: s.y });
  fireEvent.mouseMove(document, { clientX: s.x + 8, clientY: s.y + 8 });
  await settle();
  fireEvent.mouseMove(document, { clientX: to.x, clientY: to.y });
  await settle();
  const markerShown = !(document.querySelector("[data-drop-marker]") as HTMLElement | null)?.hidden;
  if (opts.escape) {
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await settle();
    // A person lets go well after the Escape: past the 50ms dnd-kit's own click guard lasts.
    await new Promise((r) => setTimeout(r, 60));
  }
  const end = opts.back ? s : to;
  if (opts.back) {
    fireEvent.mouseMove(document, { clientX: end.x, clientY: end.y });
    await settle();
  }
  fireEvent.pointerUp(opts.back ? source : document, { clientX: end.x, clientY: end.y });
  fireEvent.mouseUp(opts.back ? source : document, { clientX: end.x, clientY: end.y });
  if (opts.back) fireEvent.click(source);
  for (let i = 0; i < 3; i++) await settle();
  // dnd-kit swallows every click for 50ms after a drag ends, the next test's included.
  await new Promise((r) => setTimeout(r, 60));
  return { markerShown };
}

test("pointer: a tray chip dragged into the row lands where it was let go", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Lighting");
    placeRects("l-light");
    try {
      // The row: Clock, Time, Item, Lighting. Let go on Lighting's left half: before it.
      const lighting = document.querySelector('[data-cols="l-light"] [data-sort-id="r-light"]')!;
      const r = lighting.getBoundingClientRect();
      const { markerShown } = await carry(screen.getByRole("button", { name: "Add Band" }), { x: r.left + 10, y: r.top + 15 });
      assert.equal(markerShown, true, "no drop marker while carrying");
      await eventually(() => assert.deepEqual(s.layouts()[1].columnRoles, ["r-band", "r-light"]));
      await eventually(() => assert.match(said(), /Added Band as role column 1 of 2\./));
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  } finally {
    s.restore();
  }
});

test("pointer: a page that scrolls mid-drag does not move the drop off the pointer", async () => {
  // dnd-kit's delta counts how far its scrollable ancestors have scrolled since the drag
  // began, while the rects are read in the viewport. The page scrolls 300px under the
  // drag, the rects move up with it, and the pointer follows the tray to where it now is.
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    render(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
        React.createElement(
          "div",
          { "data-scroller": true, style: { overflow: "auto", height: "600px" } },
          React.createElement(TooltipProvider, null, React.createElement(ServiceCueSection), React.createElement(ConfirmHost)),
        ),
      ),
    );
    for (let i = 0; i < 5; i++) await settle();
    await openCard("Audio");
    placeRects("l-audio");
    // The scroller is far larger than the pointer's travel, so dnd-kit's edge
    // auto-scroll never starts.
    const scroller = document.querySelector("[data-scroller]")!;
    rects.set(scroller, { x: -2000, y: -2000, w: 5000, h: 5000 });
    try {
      const band = grip("the Band column");
      const from = centre(band);
      const tray = document.querySelector('[data-tray="l-audio"]')!;
      const at = centre(tray);
      fireEvent.mouseDown(band, { button: 0, clientX: from.x, clientY: from.y });
      fireEvent.mouseMove(document, { clientX: from.x + 8, clientY: from.y + 8 });
      await settle();
      fireEvent.mouseMove(document, { clientX: at.x, clientY: at.y });
      await settle();
      Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => 300 });
      placeRects("l-audio", -300);
      fireEvent.scroll(scroller);
      await settle();
      fireEvent.mouseMove(document, { clientX: at.x, clientY: at.y - 300 });
      await settle();
      fireEvent.mouseUp(document, { clientX: at.x, clientY: at.y - 300 });
      for (let i = 0; i < 3; i++) await settle();
      await new Promise((r) => setTimeout(r, 60));
      await eventually(() => assert.deepEqual(s.layouts()[0].columnRoles, ["r-audio"], `the drop missed the tray: "${said()}"`));
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  } finally {
    s.restore();
  }
});

test("pointer: a layout card or a category let go where it was saves nothing", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await eventually(() => grip("the Lighting layout"));
    placeStack("r-audio");
    try {
      // Lighting is second; let go on its own lower half.
      await carry(grip("the Lighting layout"), { x: 400, y: 100 });
      await eventually(() => assert.match(said(), /Lighting dropped where it was\. Nothing changed\./));
      assert.equal(saves(s, "/api/servicecue/layouts"), 0, "a layout card let go in its own place saved");
      // Sound is the second category of Audio; let go on its own right half.
      await carry(grip("Sound in Audio"), { x: 160, y: 313 });
      await eventually(() => assert.match(said(), /Sound dropped where it was\. Nothing changed\./));
      assert.equal(saves(s, "/api/servicecue/roles"), 0, "a category let go in its own place saved");
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  } finally {
    s.restore();
  }
});

test("pointer and keyboard: a drop where it already was saves nothing and says so", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    placeRects("l-audio");
    try {
      const band = document.querySelector('[data-cols="l-audio"] [data-sort-id="r-band"]')!;
      const r = band.getBoundingClientRect();
      await carry(grip("the Band column"), { x: r.left + r.width - 5, y: r.top + 15 });
      await eventually(() => assert.match(said(), /Band dropped where it was\. Nothing changed\./));
      assert.equal(saves(s, "/api/servicecue/layouts"), 0, "a drop on its own spot saved");
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
    const g = grip("the Audio column");
    g.focus();
    await press(g, " ", " ");
    await eventually(() => assert.match(said(), /Dropped Audio at position 1 of 2\./));
    for (let i = 0; i < 3; i++) await settle();
    assert.equal(saves(s, "/api/servicecue/layouts"), 0, "picked up and put down in place, and saved");
  } finally {
    s.restore();
  }
});

test("a refused layout delete keeps the card, says what failed, and announces no delete", async () => {
  const s = serviceCueServer({
    layouts: LAYOUTS,
    roles: ROLES,
    shown: ["sun"],
    types: TYPES,
    override: (url, init) => (init?.method === "POST" && url.endsWith("/api/servicecue/layouts") ? reply(500, { error: "disk full" }) : undefined),
  });
  try {
    await mount();
    await openCard("Lighting");
    fireEvent.click(screen.getByRole("button", { name: "Delete Lighting" }));
    fireEvent.click(within(await eventually(() => screen.getByRole("alertdialog"))).getByRole("button", { name: "Delete layout" }));
    await eventually(() => assert.match(alerts(), /disk full/));
    // The announcer speaks 30ms after it is told: wait past that.
    await new Promise((r) => setTimeout(r, 80));
    assert.doesNotMatch(said(), /Deleted Lighting/, "a delete the server refused was announced");
    assert.deepEqual(s.layouts().map((l) => l.id), ["l-audio", "l-light"]);
  } finally {
    s.restore();
  }
});

test("pointer: a role column dragged onto the tray leaves the layout", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    placeRects("l-audio");
    try {
      const tray = document.querySelector('[data-tray="l-audio"]')!;
      await carry(grip("the Band column"), centre(tray));
      await eventually(() => assert.deepEqual(s.layouts()[0].columnRoles, ["r-audio"]));
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  } finally {
    s.restore();
  }
});

test("pointer: Escape cancels, and letting go back on the tray chip does not add it", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Lighting");
    placeRects("l-light");
    try {
      const row = document.querySelector('[data-cols="l-light"]')!;
      await carry(screen.getByRole("button", { name: "Add Band" }), centre(row), { escape: true, back: true });
      await eventually(() => assert.match(said(), /Move cancelled\. Nothing changed\./));
      assert.equal(saves(s, "/api/servicecue/layouts"), 0, "a cancelled drag saved, or its release counted as a click on the chip");
    } finally {
      Element.prototype.getBoundingClientRect = realRect;
    }
  } finally {
    s.restore();
  }
});
