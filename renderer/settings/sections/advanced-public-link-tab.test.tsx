// advanced-public-link-tab.test.tsx — the Public link card on Settings > Advanced.
//
// The card's own states and controls are covered in servicecue-public-link.test.tsx. What is
// asked here is that the Advanced page draws it on its own tab, mounted alone (nothing from the
// ServiceCue layouts page feeds it), that its switch writes, that "what the public sees" names
// the service types and layouts it publishes, and that Search finds it.
//
// NOT unit-tested here, driven in a browser instead (jsdom loads no stylesheet and lays
// nothing out): the card's padding inside the Advanced frame, and the tab's place in the bar.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: see servicecue-public-link.test.tsx.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { serviceCueServer } from "../../test-fixtures/servicecue-server.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { ok } from "../../test-fixtures/fetch-log.js";
import type { ServiceCueLayout } from "../../../main/types/pco.js";
import type { SectionHandlers } from "../types.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const React = await import("react");
const { AdvancedSection } = await import("./advanced-section.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");
const { ADVANCED_TABS } = await import("./advanced-settings.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(async () => {
  await settle();
  cleanup();
  resetStageState();
  resetReplayCache();
});

/** `eventually`, inside act: the card's queries settle while it polls, and React wants those updates wrapped. */
const waitFor = (check: () => unknown) => act(async () => { await eventually(check); });

const LAYOUTS: ServiceCueLayout[] = [
  { id: "l-audio", name: "Audio", order: 0, columnRoles: [] },
  { id: "l-light", name: "Lighting", order: 1, columnRoles: [] },
];
const TYPES = [{ id: "sun", name: "Sunday Morning" }, { id: "wed", name: "Wednesday Night" }];
const ORIGIN = "https://servicecue.example-account.example";

/** The server's publish settings, which a write changes as the real route does. */
function publishServer(refuse: readonly string[] = []) {
  let dto = { enabled: false, url: "", token: "", status: { enabled: false, state: "off", lastSentAt: null, lastError: null, sourceProblem: null, counts: { types: 0, plans: 0, layouts: 0 }, now: 0 }, deploy: { state: "off" } };
  const saves: Record<string, unknown>[] = [];
  const s = serviceCueServer({
    layouts: LAYOUTS,
    shown: ["sun"],
    types: TYPES,
    override: (url, init) => {
      if (url === "/api/servicecue/publish/test") return ok({ ok: true, message: "Reached the page." });
      if (refuse.includes(url)) return { ok: false, status: 500, json: async () => ({ error: "boom" }), text: async () => "boom" };
      if (!url.startsWith("/api/servicecue/publish")) return undefined;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        saves.push(body);
        dto = {
          ...dto,
          url: typeof body.url === "string" ? body.url : dto.url,
          token: typeof body.token === "string" ? "••••" : dto.token,
          enabled: typeof body.enabled === "boolean" ? body.enabled : dto.enabled,
        };
        dto.status = { ...dto.status, enabled: dto.enabled, state: dto.enabled ? "publishing" : "off" };
        return ok(dto);
      }
      return ok(dto);
    },
  });
  return { saves, restore: s.restore };
}

function mount(tab: string, onTabChange?: (t: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(AdvancedSection, {
          tab,
          onTabChange,
          stageState: { pcoConfigured: true } as never,
          updateStatus: null,
          handlers: {} as unknown as SectionHandlers,
        }),
      ),
    ),
  );
}

const sw = () => screen.getByRole("switch", { name: "Publish ServiceCue to the web" }) as HTMLButtonElement;

test("the tab is after Network, at /settings/advanced/public-link", () => {
  const ids = ADVANCED_TABS.map((t) => t.id);
  assert.equal(ids[ids.indexOf("network") + 1], "public-link");
});

test("the Public link tab draws the card alone, and its switch publishes", async () => {
  const s = publishServer();
  try {
    mount("public-link");
    await waitFor(() => assert.ok(sw()));
    assert.equal(screen.getByRole("tab", { selected: true }).textContent?.trim(), "Public link");
    assert.equal(sw().disabled, true, "the switch waits for an address and a token");
    fireEvent.change(screen.getByLabelText(/^Page address/), { target: { value: ORIGIN } });
    fireEvent.change(screen.getByLabelText(/^Publishing token/), { target: { value: "t".repeat(40) } });
    assert.equal(sw().disabled, false);
    fireEvent.click(sw());
    await waitFor(() => assert.equal(sw().getAttribute("aria-checked"), "true"));
    assert.equal(s.saves.some((b) => b.enabled === true && b.url === ORIGIN), true, "the switch never wrote");
  } finally {
    s.restore();
  }
});

test("what the public sees names the landing page's types and the layouts, read by the tab itself", async () => {
  const s = publishServer();
  try {
    mount("public-link");
    await waitFor(() => assert.ok(sw()));
    fireEvent.change(screen.getByLabelText(/^Page address/), { target: { value: ORIGIN } });
    fireEvent.change(screen.getByLabelText(/^Publishing token/), { target: { value: "t".repeat(40) } });
    fireEvent.click(sw());
    const region = () => (screen.getByRole("region", { name: "Public link" }).textContent ?? "");
    await waitFor(() => assert.ok(region().includes("Sunday Morning · follows Landing page"), region()));
    assert.ok(region().includes("Audio, Lighting, All columns · every ServiceCue layout"), region());
  } finally {
    s.restore();
  }
});

test("Search finds the Public link card", async () => {
  const s = publishServer();
  try {
    mount("search");
    await waitFor(() => screen.getByRole("searchbox"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cloudflare" } });
    await waitFor(() => assert.ok(sw()));
  } finally {
    s.restore();
  }
});

/** Turns the card on against a server that refuses `refuse`, and says what "what the public sees" holds. */
async function publishingWithout(refuse: string[]): Promise<{ summary: string; restore: () => void }> {
  const s = publishServer(refuse);
  mount("public-link");
  await waitFor(() => assert.ok(sw()));
  fireEvent.change(screen.getByLabelText(/^Page address/), { target: { value: ORIGIN } });
  fireEvent.change(screen.getByLabelText(/^Publishing token/), { target: { value: "t".repeat(40) } });
  fireEvent.click(sw());
  const region = () => screen.getByRole("region", { name: "Public link" }).textContent ?? "";
  await waitFor(() => assert.ok(region().includes("What the public sees"), region()));
  return { summary: region(), restore: s.restore };
}

test("a layouts read that fails says so, and the layouts line is not drawn as if there were none", async () => {
  const r = await publishingWithout(["/api/servicecue/layouts"]);
  try {
    assert.ok(r.summary.includes("Couldn't load the layouts, so this list is incomplete."), r.summary);
    assert.equal(r.summary.includes("every ServiceCue layout"), false, "the layouts line was drawn from a failed read");
    assert.ok(r.summary.includes("Sunday Morning"), "the service types line went with it");
  } finally {
    r.restore();
  }
});

test("a service types read that fails says so, and the types line is not drawn as if there were none", async () => {
  const r = await publishingWithout(["/api/servicecue/config"]);
  try {
    assert.ok(r.summary.includes("Couldn't load the service types, so this list is incomplete."), r.summary);
    assert.equal(r.summary.includes("No service types yet"), false, "the types line was drawn from a failed read");
    assert.equal(r.summary.includes("follows Landing page"), false);
    assert.ok(r.summary.includes("every ServiceCue layout"), "the layouts line went with it");
  } finally {
    r.restore();
  }
});
