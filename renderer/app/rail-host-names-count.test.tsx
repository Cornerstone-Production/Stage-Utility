// The Advanced row's count of host names waiting for a decision, through the
// real Rail and the real data path: GET /api/security/host-names on arrival,
// then a refetch on every `security:host-names` frame the server pushes.
//
// Every name below is INVENTED. This is a public repository.

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

const settle = () => new Promise((r) => setTimeout(r, 0));
const APP = "Rail host names test app";
const waitingName = (name: string) => ({ name, firstSeen: "", lastSeen: "", count: 1, lastFrom: "192.0.2.10", client: "Chrome" });

let waiting: ReturnType<typeof waitingName>[];
let fetchStub: ReturnType<typeof stubFetchWithLog>;

beforeEach(() => {
  waiting = [];
  fetchStub = stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok({ views: [], outputs: [], appName: APP });
    if (url.startsWith("/api/security/host-names")) return ok({ enforce: false, automatic: [], accepted: [], waiting, dismissed: [] });
    return ok({});
  });
});
afterEach(() => {
  cleanup();
  fetchStub.restore();
  resetStageState();
  resetReplayCache();
});
after(() => unmountAndTeardown(cleanup, teardown));

async function renderRail(): Promise<HTMLElement> {
  const rootRoute = createRootRoute({
    component: () =>
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
        React.createElement(Rail, { onToggleCollapsed() {}, dragging: false, onStartResize() {}, onResetWidth() {} }),
      ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const { container } = render(React.createElement(RouterProvider, { router }));
  await eventually(() => assert.ok((container.textContent ?? "").includes(APP), "the rail never read the state"));
  return container;
}

const advancedRow = (c: HTMLElement): HTMLButtonElement => {
  const row = [...c.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").startsWith("Advanced"));
  assert.ok(row, "the Advanced row is not in the rail");
  return row;
};
const countOn = (c: HTMLElement): string | null => advancedRow(c).querySelector(".tabular-nums")?.textContent ?? null;

describe("the Advanced row's count of host names", () => {
  test("is absent when nothing is waiting", async () => {
    const c = await renderRail();
    assert.equal(countOn(c), null);
  });

  test("counts the names waiting, and says so to a screen reader", async () => {
    waiting = [waitingName("stage.example.org"), waitingName("panel-2.example.org")];
    const c = await renderRail();
    await eventually(() => assert.equal(countOn(c), "2"));
    assert.equal(advancedRow(c).getAttribute("aria-label"), "Advanced, 2 host names waiting");
  });

  test("follows the server's pushes: a name arriving, and the last one decided", async () => {
    const c = await renderRail();
    const es = FakeEventSource.last;
    assert.ok(es, "the rail never opened the event stream");

    waiting = [waitingName("stage.example.org")];
    await act(async () => {
      es.push("security:host-names", { waiting: 1, enforce: false });
      await settle();
    });
    await eventually(() => assert.equal(countOn(c), "1", "a name arriving after the page loaded never reached the count"));

    waiting = [];
    await act(async () => {
      es.push("security:host-names", { waiting: 0, enforce: false });
      await settle();
    });
    await eventually(() => assert.equal(countOn(c), null, "the count outlived the name"));
  });
});
