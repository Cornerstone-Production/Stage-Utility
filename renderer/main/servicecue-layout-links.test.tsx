// servicecue-layout-links.test.tsx — the links that lead to a layout's rundown use the
// layout's stored address, not one made from its current name.
//
// A layout keeps its slug through a rename, so a tablet pinned to it keeps its page. The
// launcher's open arrow and the rundown's layout switcher build that address too; built
// from the current name, they would open the renamed layout at an address that names no
// layout, and the rundown would say so and show All columns.
//
// Driven through the app's real route table, as servicecue-back.test.tsx is (see there
// for why each hop is a fresh router). NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } = await import(
  "@tanstack/react-router"
);
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../components/ui/index.js");
const { ALL_DESTINATIONS, NESTED_ROUTES } = await import("../app/destinations.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

// Both renamed since they were made: neither name slugifies to its address.
const RENAMED = [
  { id: "svl1", name: "Audio Crew", slug: "audio", order: 0, columnRoles: [] },
  { id: "svl2", name: "Video Team", slug: "video", order: 1, columnRoles: [] },
];

function stubFetch() {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts")) return ok(RENAMED);
    if (url.includes("/api/servicecue/roles")) return ok([]);
    if (url.includes("/api/servicecue/config")) return ok({ serviceTypeIds: ["st1"] });
    if (url.includes("/api/servicecue/rundown")) {
      return ok({ serviceTypeId: "st1", planId: "p1", planTitle: "Sunday", planSeriesTitle: null, planDates: null, items: [], noteCategories: [], serviceTimes: [], timeZone: null, isActivePlan: false, isDefaultPlan: true });
    }
    if (url.includes("/api/pco/live")) return ok(null);
    if (url.includes("/api/state")) return ok({ pcoConfigured: true });
    return ok({});
  });
}

/** A page load at `href`: a new router over the app's own ServiceCue pages. */
async function loadPage(href: string) {
  cleanup();
  const root = createRootRoute({ component: Outlet });
  const pages = [...ALL_DESTINATIONS, ...NESTED_ROUTES].filter((r) => r.path.startsWith("/servicecue"));
  const router = createRouter({
    routeTree: root.addChildren(
      pages.map((r) => createRoute({ getParentRoute: () => root, path: r.path, component: r.Component })),
    ),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(RouterProvider, { router })),
    ),
  );
  for (let i = 0; i < 3; i++) await settle();
  return router;
}

test("the launcher opens a renamed layout at its stored address", async () => {
  const f = stubFetch();
  try {
    await loadPage("/servicecue");
    const link = await eventually(() => screen.getByRole("link", { name: "Open Weekend" }));
    assert.equal(new URL(link.getAttribute("href") ?? "", "http://x").pathname, "/servicecue/weekend/audio");
  } finally {
    f.restore();
  }
});

test("the rundown's layout switcher goes to a renamed layout's stored address", async () => {
  const f = stubFetch();
  try {
    const router = await loadPage("/servicecue/weekend/audio");
    const select = await eventually(() => screen.getByRole("combobox", { name: "Layout" }) as HTMLSelectElement);
    await act(async () => { fireEvent.change(select, { target: { value: "svl2" } }); });
    await eventually(() => assert.equal(router.state.location.pathname, "/servicecue/weekend/video"));
  } finally {
    f.restore();
  }
});
