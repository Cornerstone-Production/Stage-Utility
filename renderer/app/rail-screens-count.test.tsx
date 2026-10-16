// The sidebar's count of devices not set up, through the real Rail and the real
// data path: GET /api/devices on arrival, then a refetch on every `kiosk:devices`
// frame the server pushes. Nothing here polls, which is what the last test pins.
//
// Every id and name below is INVENTED. This is a public repository.
//
// NOT covered here, driven in a browser instead: where the badge sits in an
// expanded and a collapsed rail, and its colour.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installDom, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};
(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Rail } = await import("./rail.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { __resetDevicesForTests } = await import("./screens/use-devices.js");
const { DISMISSED_KEY, __resetDismissedForTests } = await import("./screens/dismissed-found.js");

type SeenDevice = import("@main/types/kiosk").SeenDevice;

const device = (id: string, over: Partial<SeenDevice> = {}): SeenDevice => ({
  id, macs: [], hostname: id, os: "Linux", ip: "192.0.2.10", firstSeen: 1, lastSeen: 2, ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 0));

const APP = "Rail count test app";
let seen: SeenDevice[];
let devicesReads: number;
let fetchStub: ReturnType<typeof stubFetchWithLog>;

beforeEach(() => {
  seen = [];
  devicesReads = 0;
  localStorage.clear();
  __resetDismissedForTests();
  fetchStub = stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok({ views: [], outputs: [], appName: APP });
    if (url.startsWith("/api/devices")) {
      devicesReads += 1;
      return ok({ scanning: false, seen, matches: {}, bound: [], health: [] });
    }
    return ok({});
  });
});
afterEach(() => {
  cleanup();
  fetchStub.restore();
  resetStageState();
  resetReplayCache();
  __resetDevicesForTests();
});
after(() => unmountAndTeardown(cleanup, teardown));

async function renderRail(url = "/"): Promise<HTMLElement> {
  const rootRoute = createRootRoute({
    component: () =>
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
        React.createElement(Rail, { onToggleCollapsed() {}, dragging: false, onStartResize() {}, onResetWidth() {} }),
      ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: [url] }) });
  const { container } = render(React.createElement(RouterProvider, { router }));
  await eventually(() => assert.ok((container.textContent ?? "").includes(APP), "the rail never read the state"));
  return container;
}

/** The Screens row's own button: not Video feeds, not a console called Screens. */
const screensRow = (c: HTMLElement): HTMLButtonElement => {
  const row = [...c.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").startsWith("Screens"));
  assert.ok(row, "the Screens row is not in the rail");
  return row;
};
const countOn = (c: HTMLElement): string | null => {
  const row = screensRow(c);
  const badge = row.querySelector(".tabular-nums");
  return badge ? badge.textContent : null;
};

describe("the Screens row's count", () => {
  test("is absent when nothing is waiting", async () => {
    const c = await renderRail();
    assert.equal(screensRow(c).getAttribute("aria-label"), null, "a row with no badge carries a label of its own");
    assert.equal(countOn(c), null);
  });

  test("counts what the server has heard, on a page that is not Screens, and says so to a screen reader", async () => {
    seen = [device("pi-1"), device("pi-2")];
    const c = await renderRail("/");
    await eventually(() => assert.equal(countOn(c), "2", "the count never appeared"));
    assert.equal(screensRow(c).getAttribute("aria-label"), "Screens, 2 not set up");
  });

  test("an answer with no lists in it reads as nothing heard, and the navigation still draws", async () => {
    // The count is read on every page, so one odd answer (a server mid-update, a
    // proxy's error body) must not throw inside the rail and take the app with it.
    fetchStub.restore();
    fetchStub = stubFetchWithLog((url) => (url.includes("/api/state") ? ok({ views: [], outputs: [], appName: APP }) : ok({})));
    const c = await renderRail();
    await act(async () => {
      await settle();
    });
    assert.equal(countOn(c), null);
  });

  test("does not count a device that is set up on another server", async () => {
    seen = [device("pi-1"), device("pi-2", { boundTo: "srv-other", unreachable: true })];
    const c = await renderRail();
    await eventually(() => assert.equal(countOn(c), "1"));
  });

  test("does not drop a device the banner has dismissed: the count is how many are not set up", async () => {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(["pi-1"]));
    seen = [device("pi-1")];
    const c = await renderRail();
    await eventually(() => assert.equal(countOn(c), "1"));
  });

  test("follows the server's pushes: a device appearing, and the last one going", async () => {
    const c = await renderRail();
    assert.equal(countOn(c), null);
    const es = FakeEventSource.last;
    assert.ok(es, "the rail never opened the event stream");

    seen = [device("pi-1")];
    await act(async () => {
      es.push("kiosk:devices", { scanning: false, seen, health: [] });
      await settle();
    });
    await eventually(() => assert.equal(countOn(c), "1", "a device heard after the page loaded never reached the count"));

    seen = [];
    await act(async () => {
      es.push("kiosk:devices", { scanning: false, seen, health: [] });
      await settle();
    });
    await eventually(() => assert.equal(countOn(c), null, "the count outlived the device"));
  });

  test("reads the listing once on arrival and again only when told, never on a timer", async () => {
    const c = await renderRail();
    await eventually(() => assert.ok(devicesReads >= 1, "the listing was never read"));
    const afterArrival = devicesReads;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    assert.equal(devicesReads, afterArrival, "the listing was read again with nothing pushed");
    const es = FakeEventSource.last!;
    await act(async () => {
      es.push("kiosk:devices", { scanning: false, seen, health: [] });
      await settle();
    });
    await eventually(() => assert.equal(devicesReads, afterArrival + 1, "a push did not cause exactly one read"));
    assert.ok(c.isConnected);
  });
});
