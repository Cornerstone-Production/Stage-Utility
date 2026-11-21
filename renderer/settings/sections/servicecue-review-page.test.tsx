// servicecue-review-page.test.tsx — the design-review changes to the ServiceCue layouts page
// and its open card (Landing page first, Row color wording, empty roles, the address and
// Used by footer), driven through the real page over the stateful settings server.
//
// NOT unit-tested here, and driven in a browser instead (jsdom loads no stylesheet and
// lays nothing out): the greyed, dotted look of an empty role's chip, where the footer
// wraps at 390px, and the popover that carries the reason on hover.

// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: a failing assert inspects the node,
// and a jsdom node takes a minute to print. Assert on `!!node` or on text.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { serviceCueServer } from "../../test-fixtures/servicecue-server.js";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
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

const TYPES = [{ id: "sun", name: "Sunday Morning" }, { id: "wed", name: "Wednesday Night" }];
const ROLES = [
  { id: "r-audio", name: "Audio", members: ["Audio", "Sound"] },
  { id: "r-light", name: "Lighting", members: ["Lighting"] },
  { id: "r-video", name: "Video", members: [] as string[] },
];
const LAYOUTS: ServiceCueLayout[] = [
  { id: "l-audio", name: "Audio", order: 0, columnRoles: ["r-audio"], slug: "audio", rowColor: "category", accentRole: "r-audio" },
  { id: "l-light", name: "Lighting", order: 1, columnRoles: ["r-light"], slug: "lighting" },
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
async function openCard(name: string): Promise<void> {
  fireEvent.click(await eventually(() => screen.getByRole("button", { name: new RegExp(`^${name},`) })));
  await settle();
}
const optionTexts = (select: HTMLElement) => [...select.querySelectorAll("option")].map((o) => `${o.textContent}${(o as HTMLOptionElement).disabled ? " [disabled]" : ""}`);

// ── F3: Row color "By column" ───────────────────────────────────────────────

test("Row color says By column and Pick a column, and an empty role cannot be picked", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    const mode = screen.getByRole("combobox", { name: "Row color" });
    assert.deepEqual(optionTexts(mode), ["From PCO", "By column", "None"]);
    const pick = screen.getByRole("combobox", { name: "Row color column" });
    assert.deepEqual(optionTexts(pick), ["Pick a column…", "Audio", "Lighting", "Video (no categories yet) [disabled]"]);
    // The stored value is unchanged: a saved layout still reads "category" and its role.
    assert.equal((mode as HTMLSelectElement).value, "category");
    assert.equal((pick as HTMLSelectElement).value, "r-audio");
    fireEvent.change(pick, { target: { value: "r-light" } });
    await eventually(() => assert.equal(s.layouts()[0].accentRole, "r-light"));
    assert.equal(s.layouts()[0].rowColor, "category");
  } finally {
    s.restore();
  }
});

// ── F6: an empty role is shown, marked, and cannot be added ─────────────────

const trayOf = (id: string) => document.querySelector(`[data-tray="${id}"]`) as HTMLElement;

test("an empty role waits in the tray greyed and unaddable, with its reason, and is not a button", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    const tray = trayOf("l-audio");
    // A role with categories is still a button to click; the empty one is not.
    assert.equal(!!tray.querySelector('button[aria-label="Add Lighting"]'), true);
    assert.equal(!!tray.querySelector('button[aria-label="Add Video"]'), false, "an empty role is offered as a button");
    const chip = tray.querySelector("[data-empty-role]") as HTMLElement | null;
    assert.equal(chip === null, false, "the empty role has no chip of its own in the tray");
    assert.equal(chip!.tagName, "SPAN");
    assert.equal(chip!.getAttribute("aria-disabled"), "true");
    assert.equal(chip!.getAttribute("aria-label"), "Video, no categories yet. Give it a category under Category roles to add it.");
    assert.match(chip!.textContent ?? "", /Video\s*No categories yet/);
    const before = s.requests.length;
    fireEvent.click(chip!);
    fireEvent.keyDown(chip!, { key: "Enter" });
    fireEvent.keyDown(chip!, { key: " " });
    await settle();
    assert.equal(s.requests.slice(before).filter((r) => r.method === "POST").length, 0, "clicking an empty role saved something");
    assert.deepEqual(s.layouts()[0].columnRoles, ["r-audio"]);
    // Its reason is said on focus, where a keyboard operator finds it.
    chip!.focus();
    await eventually(() => assert.match(document.body.textContent ?? "", /Video has no categories yet, so it would draw no column\. Give it one under Category roles\./));
  } finally {
    s.restore();
  }
});

test("the roles list tags an empty role, and giving it a category clears the tag and the greying", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, cats: { sun: ["Audio", "Lighting", "Video"] } });
  try {
    await mount();
    await openCard("Audio");
    const tags = () => [...document.querySelectorAll("[data-role-empty]")].map((t) => t.textContent);
    assert.deepEqual(tags(), ["Can't be added to a layout"]);
    assert.match((document.querySelector('[data-role="r-video"]') as HTMLElement).textContent ?? "", /No categories yet, so this column is empty\./);
    const add = (await eventually(() => screen.getByRole("combobox", { name: "Add a category to Video" }))) as HTMLSelectElement;
    const opt = [...add.querySelectorAll("option")].find((o) => o.textContent === "Video") as HTMLOptionElement;
    fireEvent.change(add, { target: { value: opt.value } });
    await eventually(() => assert.deepEqual(s.roles().find((r) => r.id === "r-video")?.members, ["Video"]));
    await eventually(() => assert.deepEqual(tags(), []));
    assert.equal(!!trayOf("l-audio").querySelector("[data-empty-role]"), false);
    assert.equal(!!trayOf("l-audio").querySelector('button[aria-label="Add Video"]'), true);
  } finally {
    s.restore();
  }
});

test("a role already a column keeps its place after losing its categories, and nothing is removed", async () => {
  const roles = [{ id: "r-audio", name: "Audio", members: [] as string[] }];
  const s = serviceCueServer({ layouts: LAYOUTS, roles, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await eventually(() => screen.getByRole("button", { name: "Audio, Clock · Time · Item · Audio" }));
    await openCard("Audio");
    assert.deepEqual(roleRow("l-audio"), ["Audio"]);
    assert.equal(s.requests.filter((r) => r.method === "POST" && r.path === "/api/servicecue/layouts").length, 0, "opening the card rewrote the layout");
    assert.deepEqual(s.layouts()[0].columnRoles, ["r-audio"]);
  } finally {
    s.restore();
  }
});
const roleRow = (layoutId: string) =>
  [...(document.querySelector(`[data-cols="${layoutId}"]`)?.querySelectorAll("[data-sort-id]") ?? [])].map((c) => c.textContent ?? "");

// ── F5: Landing page leads, and is open on a first run ──────────────────────

const landingRow = () => screen.getByRole("button", { name: /^Landing page/ });
const headingsInOrder = () =>
  [...document.querySelectorAll("h1, h2, button[aria-expanded]")]
    .map((n) => (n.tagName === "BUTTON" ? (/^Landing page/.test(n.textContent ?? "") ? "Landing page" : "") : (n.textContent ?? "")))
    .filter(Boolean);

test("Landing page is the first section, above Layouts, and open while no type is ticked", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: [], types: TYPES });
  try {
    await mount();
    assert.deepEqual(headingsInOrder().slice(0, 4), ["ServiceCue layouts", "Landing page", "Layouts", "Category roles"]);
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "true"));
    assert.equal(!!screen.queryByRole("checkbox", { name: "Sunday Morning" }), true);
    // Landing page leads now, so its layouts are below it, not above.
    assert.match(document.body.textContent ?? "", /each with the layouts below, in that order, then All columns\./);
    // Ticking the first type does not shut it under the pointer.
    fireEvent.click(screen.getByRole("checkbox", { name: "Sunday Morning" }));
    await eventually(() => assert.deepEqual(s.shown(), ["sun"]));
    assert.equal(landingRow().getAttribute("aria-expanded"), "true");
  } finally {
    s.restore();
  }
});

test("Landing page is shut when a type is ticked, and the #landing address opens it, reload included", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "false"));
    cleanup();
    window.location.hash = "#landing";
    await mount(); // a reload: a fresh page read at the same address
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "true"));
    cleanup();
    window.location.hash = "";
    await mount();
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "false"));
  } finally {
    window.location.hash = "";
    s.restore();
  }
});

test("without Planning Center the open Landing page links to Integrations; the other Connect sentences stay text", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: [], types: [], pcoConfigured: false });
  try {
    await mount();
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "true"));
    assert.equal(screen.getByRole("link", { name: "Connect Planning Center" }).getAttribute("href"), "/settings/integrations");
    assert.equal(screen.getAllByRole("link", { name: /Connect Planning Center/ }).length, 1);
  } finally {
    s.restore();
  }
});
