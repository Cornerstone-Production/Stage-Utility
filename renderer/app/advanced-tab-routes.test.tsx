// advanced-tab-routes.test.tsx — Settings > Advanced, from the URL to the tab.
//
// Mounts the real Advanced routes, through the real stage-settings hook and
// api.ts, against a stub fetch standing in for the server, inside a real router.
//
// Bare /settings/advanced replaces itself with the General tab's URL, a tab click
// is a navigation, a URL for a tab that does not exist shows General, and the
// search query outlives a move between tabs because the page is not remounted by
// the move.
//
// NOT covered here, driven in a browser instead: the rail's highlight (resolvePage
// is asserted in active-page.test.tsx; the paint is not) and the two-column grid.

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
const { DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");
const { AdvancedRoute, AdvancedTabRoute } = await import("./settings-routes.js");
const { ALL_DESTINATIONS, NESTED_ROUTES } = await import("./destinations.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => {
  cleanup();
  await settle();
  teardown();
});

let fetchStub: ReturnType<typeof stubFetchWithLog>;
beforeEach(() => {
  fetchStub = stubFetchWithLog((url) => {
    if (url === "/api/state") return ok(DEFAULT_STAGE_STATE);
    if (url.includes("/api/backup/schedule")) return ok({ enabled: false, intervalDays: 7, keep: 5, includeArchive: false, destination: "" });
    return ok(url.includes("snapshots") || url.includes("milestones") ? [] : {});
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
      createRoute({ getParentRoute: () => root, path: "/settings/advanced", component: AdvancedRoute }),
      createRoute({ getParentRoute: () => root, path: "/settings/advanced/$tab", component: AdvancedTabRoute }),
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

const selectedTab = () => (screen.getByRole("tab", { selected: true }).textContent ?? "").trim();
const here = (router: { state: { location: { pathname: string } } }) => router.state.location.pathname;

describe("Advanced's URLs", () => {
  test("the app registers the tab route, nested and untitled, beside the destination", () => {
    assert.ok(ALL_DESTINATIONS.some((d) => d.path === "/settings/advanced"));
    assert.ok(NESTED_ROUTES.some((r) => r.path === "/settings/advanced/$tab" && r.label === undefined));
  });

  test("bare /settings/advanced lands on the General tab's own URL", async () => {
    const router = await mountAt("/settings/advanced");
    await eventually(() => assert.equal(here(router), "/settings/advanced/general"));
    await eventually(() => assert.equal(selectedTab(), "General"));
  });

  test("each tab's URL opens that tab", async () => {
    const router = await mountAt("/settings/advanced/schedule");
    await eventually(() => assert.equal(selectedTab(), "Schedule"));
    assert.equal(here(router), "/settings/advanced/schedule");
  });

  test("a segment that is not a tab shows General", async () => {
    await mountAt("/settings/advanced/nonsense");
    await eventually(() => assert.equal(selectedTab(), "General"));
  });

  test("picking a tab navigates to its URL", async () => {
    const router = await mountAt("/settings/advanced/general");
    await eventually(() => assert.equal(selectedTab(), "General"));
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Video relay" }));
      await settle();
    });
    assert.equal(here(router), "/settings/advanced/video");
    await eventually(() => assert.equal(selectedTab(), "Video relay"));
  });

  test("the query outlives a move between tabs: the page is not remounted", async () => {
    const router = await mountAt("/settings/advanced/search");
    const box = await eventually(() => screen.getByRole("searchbox") as HTMLInputElement);
    fireEvent.change(box, { target: { value: "snapshot" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Network" }));
      await settle();
    });
    assert.equal(here(router), "/settings/advanced/network");
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Search" }));
      await settle();
    });
    await eventually(() => assert.equal((screen.getByRole("searchbox") as HTMLInputElement).value, "snapshot"));
  });
});
