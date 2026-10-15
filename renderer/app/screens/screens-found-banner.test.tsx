// The Screens page, through the real route: where its content sits, and the
// banner that names screens found on the network that are not set up.
//
// Driven the way screens-panel-wiring.test.tsx drives the page: the real route,
// the real stage-settings hook and the real api.ts, against a stub fetch standing
// in for the server.
//
// Every id and name below is INVENTED. This is a public repository.
//
// NOT covered here, driven in a browser instead: that "Not set up yet" actually
// sits directly under the buttons below the cards (jsdom loads no stylesheet, so
// the padding classes are asserted, not the pixels they make), the banner's
// pulse and the card's highlight ring, and the sidebar count's position in an
// expanded and a collapsed rail.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

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

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
const { TooltipProvider, Toaster, ConfirmHost } = await import("../../components/ui/index.js");
const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { __resetDevicesForTests } = await import("./use-devices.js");
const { ScreensRoute } = await import("./screens-route.js");
const { PageActionsProvider, PageActionsSlot } = await import("../page-actions.js");

type SeenDevice = import("@main/types/kiosk").SeenDevice;

const NOW = "2026-01-01T00:00:00.000Z";
const settle = () => new Promise((r) => setTimeout(r, 0));

let fetchStub: ReturnType<typeof stubFetchWithLog>;
/** What the server says it has heard and not been told to ignore. */
let seen: SeenDevice[];

after(async () => {
  cleanup();
  await settle();
  teardown();
});
afterEach(async () => {
  cleanup();
  fetchStub.restore();
  __resetReplayCacheForTests();
  __resetDevicesForTests();
  await settle();
});
beforeEach(() => {
  seen = [];
  localStorage.clear();
  fetchStub = stubFetchWithLog((url, init) => {
    if ((init?.method ?? "GET") !== "GET") return ok({ ...DEFAULT_STAGE_STATE });
    if (url === "/api/state") {
      return ok({
        ...DEFAULT_STAGE_STATE,
        outputs: [{ id: "display-1", name: "Booth panel", viewId: "wall-a" }],
        views: [{ id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW }],
      });
    }
    if (url === "/api/messages") return ok({ rev: 1, groups: [], messages: [], alerts: [] });
    if (url.startsWith("/api/devices")) return ok({ scanning: true, seen, matches: {}, bound: [], error: null });
    if (url === "/api/layout-templates" || url === "/api/presets" || url === "/api/integrations/wireless/channels") return ok([]);
    return ok({});
  });
});

async function mountScreens(): Promise<void> {
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const screens = createRoute({ getParentRoute: () => root, path: "/screens", component: ScreensRoute });
  const router = createRouter({
    routeTree: root.addChildren([screens]),
    history: createMemoryHistory({ initialEntries: ["/screens"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(PageActionsProvider, null, React.createElement(PageActionsSlot), React.createElement(RouterProvider, { router })),
        React.createElement(Toaster),
        React.createElement(ConfirmHost),
      ),
    ),
  );
  await act(async () => {
    await settle();
    await settle();
    await settle();
  });
  await eventually(() => assert.ok(screen.getByRole("button", { name: "Settings" }), "the page never drew"));
}

describe("the gap under the cards", () => {
  test("the page carries its scroll runway once, on the route, not again inside the cards' section", async () => {
    await mountScreens();
    const withRunway = [...document.querySelectorAll("[class]")].filter((el) => el.classList.contains("pb-[50vh]"));
    assert.equal(
      withRunway.length,
      1,
      `${withRunway.length} elements carry pb-[50vh]: ${withRunway.map((e) => e.getAttribute("data-flash-id") ?? e.className).join(" | ")}`,
    );
    const section = document.querySelector('[data-flash-id="displays-list"]');
    assert.ok(section, "the cards' section never drew");
    assert.equal(section.classList.contains("pb-[50vh]"), false, "half a screen of padding sits under the cards again");
    assert.ok(withRunway[0].contains(section), "the runway is not around the cards: the page would end at its last row");
  });
});
