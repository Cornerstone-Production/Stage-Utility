// The console page for the two kinds that can be a console: a custom layout and
// a calendar. The calendar has no layout, so the page draws it through
// CalendarView, with its month chevrons (the reason a calendar is worth making a
// console), and offers no layout editor; a custom console still offers one.
//
// Run through the real route against a stubbed /api/state, so what is asserted is
// what the page puts on the screen. NOT asserted: how the editor looks, or that
// the corner proximity reveals its button (a pointer and a layout measurement,
// which jsdom has neither of): that is driven in a browser. The Edit button is in
// the page whether or not it is visible, which is all that is asserted of it.
//
// Every id and name is invented.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** api.ts opens an SSE stream on first use; nothing here pushes on it. */
class FakeEventSource {
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};
(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

const { render, cleanup, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ConsoleRoute } = await import("./console-route.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});
after(() => unmountAndTeardown(cleanup, teardown));

const NOW = "2026-01-01T00:00:00.000Z";
const layout = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };
const CALENDAR = { id: "cal-console", name: "Week ahead", kind: "calendar", surface: "console", createdAt: NOW };
const CUSTOM = { id: "pad-console", name: "Booth pad", kind: "custom", surface: "console", createdAt: NOW, layout };

/** A six-week grid for August 2026, no events: CalendarView draws a notice rather
 *  than its header (and chevrons) until it has one. */
function grid() {
  const start = Date.UTC(2026, 6, 26);
  const days = Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    return { date, inMonth: date.startsWith("2026-08"), events: [] };
  });
  return { monthLabel: "August 2026", days, zone: "UTC", unplaceable: 0 };
}

async function openConsole(id: string): Promise<void> {
  const f = stubFetchWithLog((u) => {
    if (u.includes("/api/state")) {
      return ok({ views: [CALENDAR, CUSTOM], outputs: [], appName: "Stage Utility", pcoConfigured: true });
    }
    if (u.includes("/api/pco/calendar")) return ok(grid());
    return ok({});
  });
  const rootRoute = createRootRoute();
  const route = createRoute({ getParentRoute: () => rootRoute, path: "/consoles/$viewId", component: ConsoleRoute });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/consoles/${id}`] }),
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
      React.createElement(RouterProvider, { router }),
    ),
  );
  await settle();
  await settle();
  await settle();
  f.restore();
}

const has = (name: string) => screen.queryByRole("button", { name }) !== null;

describe("the console page of a calendar", () => {
  test("draws the calendar with its month chevrons", async () => {
    await openConsole(CALENDAR.id);
    assert.equal(has("Previous month"), true, "no previous-month chevron on a calendar console");
    assert.equal(has("Next month"), true, "no next-month chevron on a calendar console");
    assert.equal(screen.queryByText("Nothing on this console yet") === null, true, "a calendar was drawn as an empty layout console");
  });

  test("offers no layout editor, because a calendar has no layout to edit", async () => {
    await openConsole(CALENDAR.id);
    assert.equal(has("Edit"), false, "a calendar console offers Edit");
  });
});

describe("the console page of a custom layout", () => {
  test("still offers the layout editor", async () => {
    await openConsole(CUSTOM.id);
    assert.equal(has("Edit"), true, "a custom console lost its Edit button");
    assert.equal(has("Next month"), false, "a custom console drew a calendar's chevrons");
  });
});
