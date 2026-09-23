// History's selection used to be a bare `useState<string | null>(null)`, with
// no URL behind it. That left the Baptisms tab's past-session links with
// nowhere to send an operator: there was no address that opened one service.
//
// `historyServiceHref` is now the one place that URL is built, and
// `ServiceHistorySection` reads `?service=<key>` on load and writes it back
// when a row is selected. Driven through a REAL TanStack router
// (createMemoryHistory + RouterContextProvider), not a stub of
// useSearch/useNavigate, so what is proved is a real navigation resolving to
// the right page — not a mock agreeing with itself.
//
// RouterContextProvider, not the higher-level RouterProvider: RouterProvider
// also renders <Matches>, which renders <Transitioner> only when
// `@tanstack/router-core/isServer` reads false. That module resolves through
// Node's own "require"/"import" conditions under this test runner (no
// bundler), which picks the SERVER build and makes it read true — so
// <Transitioner> never mounts and its effect throws reading
// `router._rendered[0]` on an object Transitioner alone initializes. That is
// a packaging quirk of running this router outside a bundler, not a bug this
// page owns, so RouterContextProvider is used instead: it provides the same
// `useRouter()` context without rendering the tree that crashes.
//
// One consequence: `<Transitioner>` is also what makes the router notice a
// history change it did not itself initiate — Back, Forward, another tab.
// `router.navigate()` still updates `router.state.location` synchronously
// without it (proved below), but `router.history.back()` alone does not, so
// "Back returns to the list" is NOT asserted here. Tried and confirmed by
// direct check, not assumed: neither a bare `router.navigate()` nor an
// explicit `router.load()` afterwards fires the router's `onResolved` event
// in this harness either — it is emitted from inside `commit()`'s own
// `router.startTransition(commit, matches)` (see
// @tanstack/router-core/dist/esm/load-client.js), which needs the
// `<Matches>`/`<Transitioner>` tree actually mounted to run, the identical
// packaging quirk above. So the router noticing ANY externally-driven
// navigation and firing `onResolved` — not just literal Back — cannot be
// driven in this file at all, and — say this plainly — it was NOT driven in
// a real browser either, until now: this environment gained a scratch
// Playwright install partway through this feature's build, and a literal
// Back press on this exact page has since been confirmed there twice — the
// URL drops `?service=` and the list returns.
//
// What IS proved here: `useSelectedServiceKey`'s `onResolved` subscription
// (the one thing a click's own direct `setLocal` call does not go through —
// see that function's own doc comment) is registered, and its callback, once
// invoked, correctly reacts. "the onResolved subscription..." below captures
// the real callback the component registers (by wrapping `router.subscribe`
// before render) and calls it directly, since the router itself cannot be
// made to call it here. Removing the subscription means no callback is ever
// registered to capture, which is what fails first.
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
    if (url === "/api/attendance/history") return ok([]);
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
const {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterContextProvider,
} = await import("@tanstack/react-router");
const { ServiceHistorySection, historyServiceHref } = await import("./service-history-section.js");

afterEach(cleanup);
after(() => unmountAndTeardown(cleanup, teardown));

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * The operator's History route alone, starting at `initialUrl` — a real
 * router (see the file header for why it is mounted via
 * RouterContextProvider, not RouterProvider).
 */
function renderHistoryAt(initialUrl: string) {
  const rootRoute = createRootRoute({});
  const historyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/history/manage",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([historyRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  const view = render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(RouterContextProvider, { router, children: React.createElement(ServiceHistorySection) }),
    ),
  );
  return { view, router };
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

    const row = [...view.container.querySelectorAll("button")].find((b) => text(b).includes("Sunday 11:00"));
    assert.ok(row, "the seeded row never rendered");
    fireEvent.click(row!);
    for (let i = 0; i < 4; i++) await settle();

    assert.equal(
      view.container.querySelector('[data-testid="history-service-header"]') != null,
      true,
      "clicking a row must open its detail page, same as before this change",
    );
    assert.equal(
      (router.state.location.search as Record<string, unknown>).service,
      KEY,
      "selecting a row must write ?service=<key> back to the URL",
    );
  });
});

// Final review, Minor 9: the `onResolved` subscription in
// useSelectedServiceKey (service-history-section.tsx) was untested —
// removing it stayed green, even though it is the ONLY thing that reacts to
// Back, Forward, or a link landing on this page from elsewhere (a click's own
// `setSelectedKey` sets local state directly; see this file's own header).
describe("the onResolved subscription (Back, Forward, or a link landing here)", () => {
  test("its callback, once fired, closes the detail page — and removing the subscription means no callback is ever registered to fire", async () => {
    // What was tried, and why this is not a drive of Back itself: a bare
    // `router.navigate()` DOES update `router.state.location` synchronously
    // (proved above, and again here), but a direct check confirms `onResolved`
    // itself never fires from it — nor from an explicit `router.load()`
    // afterwards — in this harness. `onResolved` is emitted from inside
    // `commit()`'s own `router.startTransition(commit, matches)`
    // (@tanstack/router-core/dist/esm/load-client.js), which needs the
    // `<Matches>`/`<Transitioner>` tree actually mounted to run that commit —
    // the same packaging quirk (this file's own header) that keeps
    // `<Transitioner>` itself from mounting here. So the RIGHT half of this
    // guard — the router noticing Back and firing onResolved — has no way to
    // go red or green in this file; only a real browser proves it, and it has
    // been driven there twice (this file's own header, corrected).
    //
    // What CAN be proven here, and is the actual code under review: that
    // `useSelectedServiceKey` subscribes at all, and that its callback reacts
    // correctly once invoked. Captured by wrapping `router.subscribe` before
    // render, then invoked directly — bypassing the router's own broken
    // resolution pipeline, not the component's.
    installFetch();
    const rootRoute = createRootRoute({});
    const historyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/history/manage", component: () => null });
    const router = createRouter({
      routeTree: rootRoute.addChildren([historyRoute]),
      history: createMemoryHistory({ initialEntries: [historyServiceHref(KEY)] }),
    });
    const onResolvedCallbacks: (() => void)[] = [];
    const originalSubscribe = router.subscribe.bind(router);
    router.subscribe = ((eventType: string, cb: () => void) => {
      if (eventType === "onResolved") onResolvedCallbacks.push(cb);
      return originalSubscribe(eventType as never, cb as never);
    }) as typeof router.subscribe;

    const view = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(RouterContextProvider, { router, children: React.createElement(ServiceHistorySection) }),
      ),
    );
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(
      view.container.querySelector('[data-testid="history-service-header"]') != null,
      true,
      "sanity: the seeded service opened from its URL",
    );
    assert.equal(onResolvedCallbacks.length, 1, "expected useSelectedServiceKey to subscribe to onResolved exactly once");

    // A real navigation updates the router's own location (proved above too),
    // so the callback — which re-reads router.state.location itself — sees
    // the same thing a genuine Back press would leave behind.
    await router.navigate({ to: router.state.location.pathname, search: {} });
    act(() => onResolvedCallbacks[0]!());
    await settle();

    assert.equal(
      view.container.querySelector('[data-testid="history-service-header"]') != null,
      false,
      "the list must return once onResolved fires with the URL no longer naming a service",
    );
    assert.ok(text(view.container).includes("Sunday 11:00"), "the list itself must actually render");
  });
});
