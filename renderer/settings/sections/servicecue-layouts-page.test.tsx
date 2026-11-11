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
