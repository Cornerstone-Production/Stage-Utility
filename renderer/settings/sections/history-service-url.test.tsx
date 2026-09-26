// History's selection lives in the URL: /history/manage?service=<key>.
//
// `historyServiceHref` is the one place that URL is built, and
// `ServiceHistorySection` reads `?service=<key>` on load, writes it back when a
// row is selected, and follows Back, Forward or a link that lands on the page.
// Driven through a real TanStack router mounted with RouterProvider over a
// memory history, not a stub of useSearch/useNavigate, so what is proved is a
// real navigation resolving to the right page — not a mock agreeing with
// itself. test-dom.ts gives these tests the router's client build, the one the
// browser runs; see its header for why that matters.
//
// NOT asserted here: jsdom loads no stylesheet, so this does not touch layout.
// See history-service-page.test.tsx's own header for that split.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../../test-dom.js";

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

const DAY = "2026-09-20";
const KEY = "weekend:plan-1:1100";
const OTHER_KEY = "weekend:plan-1:9999";
const iso = (hhmmss: string) => new Date(`${DAY}T${hhmmss}`).toISOString();

/** One recorded service — enough of a ServiceTimeline for the row and the
 *  opened page to both render. */
function timeline() {
  return {
    serviceKey: KEY,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday 11:00",
    seriesTitle: "Rooted",
    serviceDate: DAY,
    serviceTimeId: "1100",
    serviceTimeStartsAt: iso("11:00:00"),
    startedAt: iso("11:00:00"),
    endedAt: iso("12:20:00"),
    items: [
      { itemId: "a", title: "Welcome", sequence: 0, plannedLengthSec: 300, startedAt: iso("11:00:00"), endedAt: iso("11:05:00"), actualDurationSec: 300, counted: true },
    ],
  };
}

function installFetch(): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (method !== "GET") return ok({ ok: true });
    if (url === "/api/service-timeline") return ok([timeline()]);
    if (url === "/api/attendance/history?summary=1") return ok([]);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/baptism/sessions") return ok([]);
    if (url === `/api/service-timeline/${encodeURIComponent(KEY)}`) return ok(timeline());
    if (url.startsWith("/api/service-timeline/")) return ok(null);
    if (url.startsWith("/api/attendance/history/")) return ok(null);
    if (url.startsWith("/api/spl/history/")) return ok(null);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
}

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider } = await import("../../components/ui/index.js");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import(
  "@tanstack/react-router"
);
const { ServiceHistorySection, historyServiceHref } = await import("./service-history-section.js");

afterEach(cleanup);
after(() => unmountAndTeardown(cleanup, teardown));

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** The operator's History route alone, mounted at `initialUrl`. */
function renderHistoryAt(initialUrl: string) {
  const rootRoute = createRootRoute({});
  const historyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/history/manage",
    component: () => React.createElement(TooltipProvider, null, React.createElement(ServiceHistorySection)),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([historyRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  const view = render(React.createElement(RouterProvider, { router } as never));
  return { view, router };
}

const isOpen = (view: ReturnType<typeof render>) =>
  view.container.querySelector('[data-testid="history-service-header"]') != null;

/** The seeded row, clicked, with the page it opens given time to land. */
async function clickRow(view: ReturnType<typeof render>): Promise<void> {
  const row = [...view.container.querySelectorAll("button")].find((b) => text(b).includes("Sunday 11:00"));
  assert.ok(row, "the seeded row never rendered");
  fireEvent.click(row!);
  for (let i = 0; i < 4; i++) await settle();
}

describe("historyServiceHref", () => {
  test("builds the operator page's URL for a service key, percent-encoded", () => {
    // Colons are why this is a search param and not a path segment: a service
    // key looks like "weekend:plan-1:1100", which a path segment cannot carry
    // without its own encoding rule, while a search param handles it with
    // ordinary percent-encoding. Asserted here as the literal encoded string,
    // not round-tripped back through a decoder, so a change to either the path
    // or the param name fails this test directly.
    assert.equal(historyServiceHref(KEY), "/history/manage?service=weekend%3Aplan-1%3A1100");
  });
});

describe("History opens the service named in its URL", () => {
  test("a present, known key opens that service on load, exactly as clicking its row would", async () => {
    installFetch();
    const { view } = renderHistoryAt(historyServiceHref(KEY));
    for (let i = 0; i < 6; i++) await settle();

    assert.equal(
      view.container.querySelector('[data-testid="history-service-header"]') != null,
      true,
      "the seeded service never opened from its URL",
    );
  });

  test("an unknown key falls back to the list rather than an empty page", async () => {
    installFetch();
    const { view } = renderHistoryAt(historyServiceHref(OTHER_KEY));
    for (let i = 0; i < 6; i++) await settle();

    assert.equal(
      view.container.querySelector('[data-testid="history-service-header"]') != null,
      false,
      "an unknown key must not open a detail page",
    );
    assert.ok(text(view.container).includes("Sunday 11:00"), "the list must still render, not an empty page");
  });

  test("selecting a row opens it immediately and writes ?service=<key> back to the URL", async () => {
    installFetch();
    const { view, router } = renderHistoryAt("/history/manage");
    for (let i = 0; i < 4; i++) await settle();

    await clickRow(view);

    assert.equal(isOpen(view), true, "clicking a row must open its detail page");
    assert.equal(
      (router.state.location.search as Record<string, unknown>).service,
      KEY,
      "selecting a row must write ?service=<key> back to the URL",
    );
  });
});

// A click opens the page by setting state directly, not by waiting for its own
// navigation to echo back. Everything else — Back, Forward, a link landing on
// the page — reaches the component only through its `onResolved` subscription,
// so these are the cases that fail without it.
describe("a navigation the page did not start", () => {
  test("Back from an opened service returns to the list", async () => {
    installFetch();
    const { view, router } = renderHistoryAt("/history/manage");
    for (let i = 0; i < 4; i++) await settle();
    await clickRow(view);
    assert.equal(isOpen(view), true, "sanity: the row opened");

    await act(async () => {
      router.history.back();
    });
    for (let i = 0; i < 6; i++) await settle();

    assert.equal(
      (router.state.location.search as Record<string, unknown>).service,
      undefined,
      "Back must leave a URL that names no service",
    );
    assert.equal(isOpen(view), false, "the list must return once Back resolves");
    assert.ok(text(view.container).includes("Sunday 11:00"), "the list itself must actually render");
  });

  test("a link to a service opens it on a page already showing the list", async () => {
    installFetch();
    const { view, router } = renderHistoryAt("/history/manage");
    for (let i = 0; i < 4; i++) await settle();
    assert.equal(isOpen(view), false, "sanity: the list is showing");

    // Cast: `to` and `search` are typed against the app's registered route
    // tree, not this one-route one.
    await act(async () => {
      await router.navigate({ to: "/history/manage", search: { service: KEY } } as never);
    });
    for (let i = 0; i < 6; i++) await settle();

    assert.equal(isOpen(view), true, "a navigation naming a service must open it");
  });
});
