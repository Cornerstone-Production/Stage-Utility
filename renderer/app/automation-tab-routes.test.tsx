// automation-tab-routes.test.tsx — Automation, from the URL to the tab.
//
// Mounts the real Automation routes, through the real section and api.ts, against
// a stub fetch standing in for the server, inside a real router.
//
// Bare /automation replaces itself with the Commands tab's URL and KEEPS the query
// string, because /automation?new=manual is a link other pages hold and opens the
// New command dialog; a tab click is a navigation; an arrow key moves between
// tabs and the URL follows; a URL for a tab that does not exist shows Commands;
// the Search query outlives a move between tabs because the page is not
// remounted by one.
//
// NOT covered here, driven in a browser instead: the rail's highlight
// (resolvePage is asserted in active-page.test.tsx; the paint is not), the
// underline and the right-aligned Search tab, which are stylesheet.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");
const { AutomationRoute, AutomationTabRoute } = await import("./settings-routes.js");
const { ALL_DESTINATIONS, NESTED_ROUTES } = await import("./destinations.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => {
  cleanup();
  await settle();
  teardown();
});

const REGISTRY = {
  triggers: [
    { id: "call.by-name", label: "Called by name (voice or HTTP)", channel: "cue:call", params: [{ key: "name", label: "Command name", type: "string" }] },
  ],
  conditions: [],
  actions: [{ id: "log.message", label: "Write a log message", params: [] }],
};

let fetchStub: ReturnType<typeof stubFetchWithLog>;
beforeEach(() => {
  fetchStub = stubFetchWithLog((url) => {
    if (url.includes("/api/automation/registry")) return ok(REGISTRY);
    if (url.includes("/api/automation/rules")) return ok({ rules: [], settings: { simulate: true, disarmed: false } });
    if (url.includes("/api/automation/log")) return ok({ entries: [] });
    if (url.includes("/api/cues/tokens")) return ok({ tokens: [] });
    if (url.includes("/api/cues/usage")) return ok({});
    return ok({});
  });
});
afterEach(async () => {
  cleanup();
  fetchStub.restore();
  __resetReplayCacheForTests();
  await settle();
});

async function mountAt(path: string) {
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/automation", component: AutomationRoute }),
      createRoute({ getParentRoute: () => root, path: "/automation/$tab", component: AutomationTabRoute }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(RouterProvider, { router })),
    ),
  );
  await act(async () => {
    await settle();
    await settle();
  });
  return router;
}

const selectedTab = () => (screen.getByRole("tab", { selected: true }).textContent ?? "").replace(/\d+$/, "").trim();
const here = (router: { state: { location: { pathname: string } } }) => router.state.location.pathname;

describe("Automation's URLs", () => {
  test("the app registers the tab route, nested and untitled, beside the destination", () => {
    assert.ok(ALL_DESTINATIONS.some((d) => d.path === "/automation"));
    assert.ok(NESTED_ROUTES.some((r) => r.path === "/automation/$tab" && r.label === undefined));
  });

  test("the tabs are Commands, Rules, Activity, Access and Search, in that order", async () => {
    await mountAt("/automation/commands");
    await eventually(() => assert.equal(screen.getAllByRole("tab").length, 5));
    assert.deepEqual(
      screen.getAllByRole("tab").map((t) => (t.textContent ?? "").replace(/\d+$/, "").trim()),
      ["Commands", "Rules", "Activity", "Access", "Search"],
    );
  });

  test("bare /automation lands on the Commands tab's own URL", async () => {
    const router = await mountAt("/automation");
    await eventually(() => assert.equal(here(router), "/automation/commands"));
    await eventually(() => assert.equal(selectedTab(), "Commands"));
  });

  test("/automation?new=manual keeps its query across the redirect and opens New command", async () => {
    const router = await mountAt("/automation?new=manual");
    await eventually(() => assert.equal(here(router), "/automation/commands"));
    // The dialog opened, on the manual kind's first step, and the parameter was
    // dropped once it had: a reload must not open it a second time.
    await eventually(() => assert.ok(document.querySelector("[data-new-cue]"), "the link did not open the dialog"));
    await eventually(() => assert.equal("new" in (router.state.location.search as Record<string, unknown>), false));
  });

  test("each tab's URL opens that tab", async () => {
    const router = await mountAt("/automation/rules");
    await eventually(() => assert.equal(selectedTab(), "Rules"));
    assert.equal(here(router), "/automation/rules");
  });

  test("a segment that is not a tab shows Commands", async () => {
    await mountAt("/automation/nonsense");
    await eventually(() => assert.equal(selectedTab(), "Commands"));
  });

  test("picking a tab navigates to its URL", async () => {
    const router = await mountAt("/automation/commands");
    await eventually(() => assert.equal(selectedTab(), "Commands"));
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /^Activity/ }));
      await settle();
    });
    assert.equal(here(router), "/automation/activity");
    await eventually(() => assert.equal(selectedTab(), "Activity"));
  });

  test("an arrow key moves to the next tab, and the URL follows", async () => {
    const router = await mountAt("/automation/commands");
    await eventually(() => assert.equal(selectedTab(), "Commands"));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "ArrowRight" });
      await settle();
    });
    assert.equal(here(router), "/automation/rules");
    await eventually(() => assert.equal(selectedTab(), "Rules"));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "End" });
      await settle();
    });
    assert.equal(here(router), "/automation/search");
  });

  test("Simulate and Disarm sit above the tab bar, on every tab", async () => {
    await mountAt("/automation/access");
    await eventually(() => assert.ok(screen.getByRole("switch", { name: "Simulate mode" })));
    const simulate = screen.getByRole("switch", { name: "Simulate mode" });
    const disarm = screen.getByRole("button", { name: /Disarm all/ });
    const tablist = screen.getByRole("tablist");
    // compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING (4) means the tab bar comes after.
    assert.ok(simulate.compareDocumentPosition(tablist) & 4, "Simulate is below the tab bar");
    assert.ok(disarm.compareDocumentPosition(tablist) & 4, "Disarm is below the tab bar");
  });

  test("the query outlives a move between tabs: the page is not remounted", async () => {
    const router = await mountAt("/automation/search");
    const box = await eventually(() => screen.getByRole("searchbox") as HTMLInputElement);
    fireEvent.change(box, { target: { value: "projectors" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: /^Rules/ }));
      await settle();
    });
    assert.equal(here(router), "/automation/rules");
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Search" }));
      await settle();
    });
    await eventually(() => assert.equal((screen.getByRole("searchbox") as HTMLInputElement).value, "projectors"));
  });
});
