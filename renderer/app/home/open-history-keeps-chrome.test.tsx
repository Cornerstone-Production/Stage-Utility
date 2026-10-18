// open-history-keeps-chrome.test.tsx — a link from inside the shell never lands
// on a page the shell draws no chrome on.
//
// Home's Recent services card led to `/history`, the read-only page handed to
// volunteers. That page renders with no sidebar and no way back, so an operator
// who pressed "Open History" lost the app and had only the browser's Back.
// `/history/manage` is History in the rail.
//
// Driven through the real card, the app's REAL route table and a real router.
// jsdom cannot see whether the sidebar is on screen, so chromelessness is asserted
// through hidesChrome, the function the shell asks; the pictures are in the
// browser run.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { DRILLDOWN } from "@main/types/object-capabilities";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { RecentServicesCard } = await import("./cards.js");
const { ALL_DESTINATIONS, NESTED_ROUTES } = await import("../destinations.js");
const { hidesChrome, resolvePage } = await import("../active-page.js");
const { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } = await import(
  "@tanstack/react-router"
);

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const WEEKENDS = ["2026-08-16", "2026-08-23", "2026-08-30"];
const ATTENDANCE = WEEKENDS.map((day, i) => ({
  serviceKey: `st-1:plan-${day}:${day}`,
  serviceTypeId: "st-1",
  serviceTypeName: "Weekend",
  planId: `plan-${day}`,
  planTitle: "Sample plan",
  seriesTitle: null,
  serviceDate: day,
  serviceTimeId: null,
  serviceTimeStartsAt: `${day}T15:00:00.000Z`,
  startedAt: `${day}T15:00:00.000Z`,
  endedAt: `${day}T16:30:00.000Z`,
  samples: [],
  attendanceBaseline: 0,
  totalAttendance: 200 + i * 10,
  peakAttendance: 200 + i * 10,
  peakOccupancy: 200 + i * 10,
  minOccupancy: 0,
  lastAttendance: 200 + i * 10,
  lastOccupancy: 200 + i * 10,
})) as ServiceAttendance[];

/** Home hosting the card, beside every History page the app really routes. */
function homeRouter() {
  const root = createRootRoute({});
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () =>
      React.createElement(RecentServicesCard, {
        state: { serviceTypeId: "st-1", serviceTypeName: "Weekend" } as StageState,
      }),
  });
  // The pages themselves are not under test, only where the link lands, so they
  // render nothing; the PATHS are the app's own.
  const pages = [...ALL_DESTINATIONS, ...NESTED_ROUTES]
    .filter((r) => r.path.startsWith("/history"))
    .map((r) => createRoute({ getParentRoute: () => root, path: r.path, component: () => null }));
  return createRouter({
    routeTree: root.addChildren([home, ...pages]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

test("Home's Open History lands on the History in the shell, not the chromeless page", async () => {
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/service-timeline")) return ok([]);
    if (url.includes("/api/attendance/history")) return ok(ATTENDANCE);
    if (url.includes("/api/spl/summary")) return ok([]);
    return ok({});
  });
  try {
    const router = homeRouter();
    render(React.createElement(RouterProvider, { router }));
    await settle();
    const link = await eventually(() => screen.getByRole("link", { name: "Open History" }));

    fireEvent.click(link);
    await settle();
    await settle();

    const landed = router.state.location.pathname;
    assert.equal(landed, "/history/manage");
    assert.equal(hidesChrome(landed, undefined), false, "the page it lands on keeps the sidebar");
    assert.equal(resolvePage(landed)?.page.label, "History", "and it is History in the rail");
  } finally {
    f.restore();
  }
});

test("no object's drill-down target is a page without the shell's chrome", () => {
  // DRILLDOWN is where a press goes "in the operator shell", so a target that
  // hides the chrome strands the operator exactly as the Home link did.
  const stranded = Object.entries(DRILLDOWN)
    .filter(([, route]) => hidesChrome(route as string, undefined))
    .map(([type, route]) => `${type} -> ${route}`);
  assert.deepEqual(stranded, []);
});
