// A screen's message groups, from the click to the server.
//
// output-groups-menu.test.tsx drives OutputRow with injected props, so it cannot
// see the half of the path that is wired in elsewhere: which output id a tick
// sends, whether the page hands the card the groups the server really holds,
// what the Screens page does when the PATCH fails, and where "No groups yet"
// goes. Replacing onSetGroups with a no-op, passing the wrong output id, feeding
// the card a made-up group list, dropping the link and sending `{ groups: [] }`
// from api.ts each stayed green there.
//
// This mounts the real Screens route, through the real stage-settings hook and
// the real api.ts, against a stub fetch standing in for the server, inside a
// real router. Two screens, so a tick that reaches the wrong one shows.
//
// Every id and name below is INVENTED. This is a public repository.
//
// NOT covered here, driven in a browser instead: the chips' look and the menu's
// position. jsdom loads no stylesheet.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

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
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");
const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { ScreensRoute } = await import("./screens-route.js");
const { ALL_DESTINATIONS, NESTED_ROUTES } = await import("../destinations.js");

type Output = import("@main/types/views").Output;

const GREEN = { id: "g-11111111", name: "Green room" };
const STAGE = { id: "g-22222222", name: "Stage" };

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => {
  cleanup();
  await settle();
  teardown();
});
afterEach(async () => {
  cleanup();
  fetchStub.restore();
  __resetReplayCacheForTests();
  await settle();
});

let fetchStub: ReturnType<typeof stubFetchWithLog>;
let outputs: Output[];
let messageGroups: { id: string; name: string }[];
let patches: { url: string; body: unknown }[];
let patchFails: boolean;
/** While set, every PATCH waits for it: a tick whose answer has not come back. */
let patchGate: Promise<void> | null;

beforeEach(() => {
  outputs = [
    { id: "display-1", name: "Stage left", viewId: null },
    { id: "display-2", name: "Booth", viewId: null },
  ];
  messageGroups = [GREEN, STAGE];
  patches = [];
  patchFails = false;
  patchGate = null;
  fetchStub = stubFetchWithLog((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "PATCH" && url.startsWith("/api/outputs/")) {
      const body = JSON.parse(String(init?.body)) as { groups?: string[] };
      patches.push({ url, body });
      if (patchFails) return reply(500, { error: "disk full" });
      const id = decodeURIComponent(url.slice("/api/outputs/".length));
      const answer = () => {
        outputs = outputs.map((o) => (o.id === id ? { ...o, groups: body.groups } : o));
        return ok({ ...DEFAULT_STAGE_STATE, outputs });
      };
      return patchGate ? patchGate.then(answer) : answer();
    }
    if (url === "/api/state") return ok({ ...DEFAULT_STAGE_STATE, outputs });
    if (url === "/api/messages") return ok({ rev: 1, groups: messageGroups, messages: [], alerts: [] });
    // What the rest of the page reads on mount; none of it is what is under test.
    if (url.startsWith("/api/devices")) return ok({ scanning: false, seen: [], matches: {}, bound: [], error: null });
    if (url === "/api/layout-templates" || url === "/api/presets" || url === "/api/integrations/wireless/channels") return ok([]);
    return ok({});
  });
});

/** The real Screens route, with a router that can tell where a click went. */
async function mountScreens() {
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const screens = createRoute({ getParentRoute: () => root, path: "/screens", component: ScreensRoute });
  const messages = createRoute({
    getParentRoute: () => root,
    path: "/settings/messages",
    component: () => React.createElement("p", { "data-testid": "messages-page" }, "Messages settings"),
  });
  const router = createRouter({
    routeTree: root.addChildren([screens, messages]),
    history: createMemoryHistory({ initialEntries: ["/screens"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(RouterProvider, { router }), React.createElement(Toaster)),
    ),
  );
  await act(async () => {
    await settle();
    await settle();
    await settle();
  });
  return router;
}

/** The overflow menu of the screen with this name (cards are in the outputs' order), then its Groups submenu. */
async function openGroups(screenName: string): Promise<void> {
  const triggers = screen.getAllByLabelText(/more actions/i);
  const index = outputs.findIndex((o) => o.name === screenName);
  await act(async () => {
    fireEvent.pointerDown(triggers[index], { button: 0, ctrlKey: false });
    fireEvent.click(triggers[index]);
    await settle();
  });
  await act(async () => {
    fireEvent.keyDown(screen.getByText("Groups"), { key: "ArrowRight" });
    await settle();
  });
}

describe("ticking a group on a screen's card", () => {
  test("PATCHes THAT screen with the whole new list, and the chip appears", async () => {
    await mountScreens();
    await openGroups("Booth");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Stage" }));
      await settle();
      await settle();
    });
    assert.deepEqual(
      patches,
      [{ url: "/api/outputs/display-2", body: { groups: [STAGE.id] } }],
      "the tick did not reach the server as a PATCH of the screen it was made on",
    );
    const chips = [...document.querySelectorAll('[data-testid="screen-groups"] li')].map((li) => li.textContent);
    assert.deepEqual(chips, ["Stage"]);
  });

  test("a second tick before the first is answered is built on the first: the whole list, both groups", async () => {
    let release!: () => void;
    patchGate = new Promise<void>((r) => (release = r));
    await mountScreens();
    await openGroups("Booth");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Green room" }));
      await settle();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Stage" }));
      await settle();
    });
    assert.deepEqual(
      patches.map((p) => p.body),
      [{ groups: [GREEN.id] }, { groups: [GREEN.id, STAGE.id] }],
      "the second tick was built from the screen as the server last said it, and undid the first",
    );
    await act(async () => {
      release();
      await settle();
      await settle();
    });
  });

  test("offers the groups the server holds, not a made-up list", async () => {
    messageGroups = [{ id: "g-44444444", name: "Lobby crew" }];
    await mountScreens();
    await openGroups("Stage left");
    const boxes = screen.getAllByRole("menuitemcheckbox").map((b) => b.textContent);
    assert.deepEqual(boxes.filter((t) => t === "Lobby crew" || t === "Green room" || t === "Stage"), ["Lobby crew"]);
  });

  test("a tick the server refuses is undone and says so", async () => {
    patchFails = true;
    await mountScreens();
    await openGroups("Booth");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Green room" }));
      await settle();
      await settle();
      await settle();
    });
    assert.equal(patches.length, 1, "no PATCH was sent");
    assert.equal(document.querySelector('[data-testid="screen-groups"]'), null, "the chip stayed after the server refused");
    assert.match(document.body.textContent ?? "", /Failed to update the screen's groups/);
  });
});

describe("a screen with no groups to choose from", () => {
  test("'No groups yet' goes to Settings -> Messages", async () => {
    messageGroups = [];
    const router = await mountScreens();
    await openGroups("Stage left");
    await act(async () => {
      fireEvent.click(screen.getByText(/No groups yet/));
      await settle();
      await settle();
    });
    assert.equal(router.state.location.pathname, "/settings/messages");
  });

  test("/settings/messages is a page the app really has", () => {
    assert.ok(
      [...ALL_DESTINATIONS, ...NESTED_ROUTES].some((d) => d.path === "/settings/messages"),
      "the link goes to a path no route answers",
    );
  });
});
