// servicecue-layouts-page.test.tsx — the ServiceCue layouts page, driven through the real
// section over a server that saves by the store's own rules (test-fixtures/servicecue-server).
//
// What is under test is what an operator can be misled by or stuck at: a section that is
// not there to use, a control that saves the wrong thing, a confirm that names the wrong
// layouts.
//
// NOT unit-tested here, and driven in a browser instead (jsdom loads no stylesheet and lays
// nothing out): the 260px cap on the preview and its inner scroll, the drop marker's place,
// the drag ghost, touch, and how the page looks beside the mockup at 1280 and 390.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see servicecue-section-reads.test.tsx.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { serviceCueServer } from "../../test-fixtures/servicecue-server.js";
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
