// Every surface that draws the rundown draws it on a kiosk ground.
//
// The rundown's brightest text is `text-fg-strong`, and `--color-fg-strong`
// resolves at :root: inside `.kiosk-surface` it is the literal white the class
// re-declares, anywhere else in the LIGHT app it is the light theme's `#000`. So a
// surface that loses `.kiosk-surface` keeps rendering, keeps passing every
// class-name assertion, and draws black department notes on a near-black panel.
// The page was pinned by a source match in servicecue-full-bleed.test.ts; the
// ServiceCue view (which is also what an embedded view of kind `script` renders,
// through embedded-view.tsx) was not pinned at all.
//
// Asked of RENDERED output: the table's nearest `.kiosk-surface` ancestor, with a
// plan on screen. A source match would be satisfied by the class on the loading
// state's wrapper, which is a different element.
//
// The settings preview is in settings/sections/servicecue-section-preview.test.tsx.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ServiceCue } = await import("./servicecue-view.js");
const { ServiceCuePlan } = await import("./servicecue-plan-view.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RUNDOWN: ServiceCueRundownDTO = {
  serviceTypeId: "st1",
  planId: "p1",
  planTitle: "Sunday",
  planSeriesTitle: null,
  planDates: null,
  items: [
    { id: "i1", title: "Opening song", itemType: "song", lengthSec: 300, sequence: 0, notesByCategory: { Audio: "Kick up" }, description: null },
  ],
  noteCategories: ["Audio"],
  serviceTimes: [],
  timeZone: null,
  isActivePlan: false,
  isDefaultPlan: true,
};

function stubFetch() {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok({ serviceTypeId: "st1", planId: "p1", pcoConfigured: true });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts")) return ok([{ id: "svl1", name: "Audio", order: 0, columnRoles: ["r1"] }]);
    if (url.includes("/api/servicecue/roles")) return ok([{ id: "r1", name: "Sound", members: ["Audio"] }]);
    if (url.includes("/api/servicecue/rundown")) return ok(RUNDOWN);
    if (url.includes("/api/pco/live")) return ok(null);
    return ok({});
  });
}

/** Whether the rendered rundown table sits inside a `.kiosk-surface`, and that a table rendered at all. */
function tableGround(): { table: boolean; ground: boolean } {
  const table = document.querySelector("table");
  return { table: !!table, ground: !!table?.closest(".kiosk-surface") };
}

async function mountInto(element: React.ReactElement): Promise<void> {
  render(React.createElement(TooltipProvider, null, element));
  await settle();
  await settle();
  await settle();
}

/** The page reads its plan from the URL and its plan list through React Query, so
 *  it mounts the way the app does: under a router and a query client. */
async function mountPage(): Promise<void> {
  const rootRoute = createRootRoute({});
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/servicecue/$serviceType/$layout",
    component: () => React.createElement(ServiceCuePlan, { serviceTypeParam: "weekend", layoutParam: "audio" }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/servicecue/weekend/audio"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await mountInto(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
}

test("the ServiceCue view draws its rundown on a kiosk ground", async () => {
  const f = stubFetch();
  try {
    await mountInto(React.createElement(ServiceCue, { serviceCueLayoutId: "svl1" }));
    assert.deepEqual(tableGround(), { table: true, ground: true });
  } finally {
    f.restore();
  }
});

test("the ServiceCue page draws its rundown on a kiosk ground", async () => {
  const f = stubFetch();
  try {
    await mountPage();
    assert.deepEqual(tableGround(), { table: true, ground: true });
  } finally {
    f.restore();
  }
});
