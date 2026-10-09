// The Screen settings panel, from the click to the server, through the real
// Screens route.
//
// screen-settings-panel.test.tsx drives the panel with injected callbacks, so it
// cannot see how each callback is WIRED: which request a switch sends, to which
// screen, with which body. A panel whose every switch rendered and did nothing,
// or whose Create screen called the wrong route, stayed green there. This mounts
// the real route, through the real stage-settings hook and the real api.ts,
// against a stub fetch standing in for the server, and asserts on the requests.
//
// Two screens that share a view, so a request that reaches the wrong one shows,
// and a role change that touches the other shows.
//
// Every id and name below is INVENTED. This is a public repository.
//
// NOT covered here, driven in a browser instead: the panel's width and position
// beside the cards, the selected card's border, and a real kiosk device
// announcing itself. jsdom loads no stylesheet.

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

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
const { TooltipProvider, Toaster, ConfirmHost } = await import("../../components/ui/index.js");
const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { ScreensRoute } = await import("./screens-route.js");

type Output = import("@main/types/views").Output;
type View = import("@main/types/views").View;

const NOW = "2026-01-01T00:00:00.000Z";
const WALL: View = { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW };
const CONSOLE: View = { id: "ctl-a", name: "Booth controls", kind: "custom", surface: "console", createdAt: NOW };
const STAGE_GROUP = { id: "g-22222222", name: "Stage" };

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
let views: View[];
let seenDevices: unknown[];
/** Every write the page made, in order. */
let writes: { method: string; url: string; body: unknown }[];
let claimFails: string | null;

beforeEach(() => {
  outputs = [
    { id: "display-1", name: "Booth panel", viewId: "ctl-a", mode: "panel" },
    { id: "display-2", name: "Stage panel", viewId: "ctl-a", mode: "panel" },
    { id: "display-3", name: "Lobby TV", viewId: "wall-a" },
  ];
  views = [WALL, CONSOLE];
  seenDevices = [];
  writes = [];
  claimFails = null;
  fetchStub = stubFetchWithLog((url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      // Only the writes that change a screen, a view or a claim. The page also
      // keeps a device scan alive and (re)subscribes to its event channels while
      // it is open, and neither is a change to anything.
      if (/^\/api\/(outputs|views|devices\/claim)/.test(url)) writes.push({ method, url, body });
      if (url === "/api/devices/claim" && claimFails) return reply(400, { error: claimFails });
      // Answer with the state as it stands: what these tests assert is the
      // REQUEST. The optimistic handlers reconcile to whatever comes back.
      return ok(state());
    }
    if (url === "/api/state") return ok(state());
    if (url === "/api/messages") return ok({ rev: 1, groups: [STAGE_GROUP], messages: [], alerts: [] });
    if (url.startsWith("/api/devices")) {
      return ok({ scanning: false, seen: seenDevices, matches: {}, bound: [], error: null });
    }
    if (url === "/api/layout-templates" || url === "/api/presets" || url === "/api/integrations/wireless/channels") return ok([]);
    return ok({});
  });
});

const state = () => ({ ...DEFAULT_STAGE_STATE, outputs, views });

async function mountScreens() {
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const screens = createRoute({ getParentRoute: () => root, path: "/screens", component: ScreensRoute });
  const messages = createRoute({
    getParentRoute: () => root,
    path: "/settings/messages",
    component: () => React.createElement("p", null, "Messages settings"),
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
      React.createElement(TooltipProvider, null, React.createElement(RouterProvider, { router }), React.createElement(Toaster), React.createElement(ConfirmHost)),
    ),
  );
  await act(async () => {
    await settle();
    await settle();
    await settle();
  });
  return router;
}

const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
    await settle();
    await settle();
  });
};
const choose = async (el: Element, value: string) => {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
    await settle();
    await settle();
  });
};
const type = async (el: Element, value: string) => {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
    await settle();
  });
};

/** Choose a menu item by pressing it the way Radix expects. */
async function pressMenuItem(name: string): Promise<void> {
  const item = screen.getByRole("menuitem", { name });
  await act(async () => {
    fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(item, { button: 0, ctrlKey: false });
    fireEvent.click(item);
    await settle();
  });
}

/** Open this screen's menu, then its Screen settings panel. */
async function openSettings(screenName: string): Promise<void> {
  const trigger = screen.getByLabelText(`More actions for ${screenName}`);
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settle();
  });
  await pressMenuItem("Screen settings…");
}

const panel = () => within(screen.getByRole("complementary", { name: "Screen settings" }));
const sw = (name: string) => panel().getByRole("switch", { name });
const answerConfirm = async (label: string) => {
  const dialog = await screen.findByRole("alertdialog");
  await click(within(dialog).getByRole("button", { name: label }));
};

describe("opening the panel", () => {
  test("Screen settings… in a card's menu opens THAT screen's panel", async () => {
    await mountScreens();
    assert.equal(screen.queryByRole("complementary", { name: "Screen settings" }) !== null, false, "the panel is open before anything asked for it");
    await openSettings("Lobby TV");
    assert.ok(panel().getByRole("heading", { name: "Lobby TV" }));
  });

  test("closing it leaves the page as it was and sends nothing", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(panel().getByRole("button", { name: "Close" }));
    assert.equal(screen.queryByRole("complementary", { name: "Screen settings" }) !== null, false, "it is on screen");
    assert.deepEqual(writes, []);
  });
});

describe("each setting reaches the server", () => {
  test("the top-bar switch PATCHes THAT screen", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(sw("Top bar"));
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { hideTopBar: true } }]);
  });

  test("the lock switch PATCHes locked", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(sw("Lock"));
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { locked: true } }]);
  });

  test("the HLS switch PATCHes allowHls", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(sw("Use HLS"));
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { allowHls: false } }]);
  });

  test("a message group tick PATCHes the whole list", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(panel().getByRole("checkbox", { name: "Stage" }));
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { groups: [STAGE_GROUP.id] } }]);
  });

  test("text size PATCHes the same field the display itself writes, once, when it settles", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    const field = panel().getByLabelText("Text size");
    await act(async () => { fireEvent.focus(field); await settle(); });
    await type(field, "130");
    assert.deepEqual(writes, [], "a keystroke was written");
    await act(async () => { fireEvent.blur(field); await settle(); await settle(); });
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { textSize: 130 } }]);
  });

  test("the friendly link PATCHes slug", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await type(panel().getByLabelText(/Friendly link/), "Lobby");
    await click(panel().getByRole("button", { name: "Save" }));
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { slug: "lobby" } }]);
  });

  test("the name PATCHes the screen on blur", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    const name = panel().getByLabelText("Name");
    await type(name, "Atrium TV");
    await act(async () => { fireEvent.blur(name); await settle(); await settle(); });
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { name: "Atrium TV" } }]);
  });

  test("choosing a view PATCHes viewId", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await choose(panel().getByLabelText("View"), "__none__");
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { viewId: null } }]);
  });

  test("the sidebar switch PATCHes showInSidebar on the VIEW, not the screen", async () => {
    await mountScreens();
    await openSettings("Booth panel");
    await click(sw("List in the sidebar"));
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/views/ctl-a", body: { showInSidebar: false } }]);
  });
});

describe("changing the role of a shared view", () => {
  test("Use a copy POSTs the role route with copyView, and touches no other screen or view", async () => {
    await mountScreens();
    await openSettings("Booth panel");
    await click(panel().getByRole("button", { name: /^Wall display/ }));
    assert.deepEqual(writes, [], "the role went out before the operator chose how");
    await click(panel().getByRole("button", { name: "Apply" }));
    await answerConfirm("Make it a display");
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs/display-1/role", body: { mode: "display", copyView: true } }]);
  });

  test("Choose a different view POSTs the role route with that view", async () => {
    await mountScreens();
    await openSettings("Booth panel");
    await click(panel().getByRole("button", { name: /^Wall display/ }));
    await click(panel().getByRole("radio", { name: /Choose a different view/ }));
    await choose(panel().getByLabelText("A different view"), "wall-a");
    await click(panel().getByRole("button", { name: "Apply" }));
    await answerConfirm("Make it a display");
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs/display-1/role", body: { mode: "display", viewId: "wall-a" } }]);
  });

  test("a view only this screen shows is changed with it, in one call and no copy", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(panel().getByRole("button", { name: /^Control surface/ }));
    await answerConfirm("Use as a control surface");
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs/display-3/role", body: { mode: "panel" } }]);
  });
});

describe("a console on no screen", () => {
  test("its card's menu has Show in the sidebar, and it PATCHes the view", async () => {
    outputs = [{ id: "display-1", name: "Lobby TV", viewId: "wall-a" }];
    views = [WALL, { ...CONSOLE, id: "ctl-free", name: "Spare controls" }];
    await mountScreens();
    const trigger = screen.getByLabelText("More actions for Spare controls");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await settle();
    });
    const item = screen.getByRole("menuitemcheckbox", { name: "Show in the sidebar" });
    assert.equal(item.getAttribute("aria-checked"), "true");
    await act(async () => {
      fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
      fireEvent.pointerUp(item, { button: 0, ctrlKey: false });
      fireEvent.click(item);
      await settle();
      await settle();
    });
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/views/ctl-free", body: { showInSidebar: false } }]);
  });

  test("a wall view's menu has no such item", async () => {
    outputs = [{ id: "display-1", name: "Lobby TV", viewId: "ctl-a", mode: "panel" }];
    views = [CONSOLE, { ...WALL, id: "wall-free", name: "Spare loop" }];
    await mountScreens();
    const trigger = screen.getByLabelText("More actions for Spare loop");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await settle();
    });
    // A boolean, not the element: a failing equal against a DOM node prints the
    // whole node and its circular fibers.
    assert.equal(screen.queryByRole("menuitemcheckbox", { name: "Show in the sidebar" }) !== null, false, "a wall view has no sidebar listing to switch");
  });
});

describe("Add a screen", () => {
  test("opens the panel in guided mode and creates NOTHING", async () => {
    await mountScreens();
    await click(screen.getByRole("button", { name: /Add a screen/ }));
    assert.ok(panel().getByText("New screen · step 1 of 3"));
    assert.deepEqual(writes, [], "a screen was created by opening the panel");
  });

  test("closing it midway leaves no screen", async () => {
    await mountScreens();
    await click(screen.getByRole("button", { name: /Add a screen/ }));
    await click(panel().getByRole("button", { name: /^Control surface/ }));
    await click(panel().getByRole("button", { name: "Next" }));
    await click(panel().getByRole("button", { name: "Close" }));
    assert.equal(screen.queryByRole("complementary", { name: "Screen settings" }) !== null, false, "it is on screen");
    assert.deepEqual(writes, []);
  });

  test("Create screen POSTs /api/outputs with the answers, and the panel closes", async () => {
    await mountScreens();
    await click(screen.getByRole("button", { name: /Add a screen/ }));
    await click(panel().getByRole("button", { name: /^Control surface/ }));
    await click(panel().getByRole("button", { name: "Next" }));
    await choose(panel().getByLabelText("View"), "__new__");
    await click(panel().getByRole("button", { name: "Next" }));
    await type(panel().getByLabelText("Name"), "Wing");
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs", body: { name: "Wing", mode: "panel", newView: true } }]);
    assert.equal(screen.queryByRole("complementary", { name: "Screen settings" }) !== null, false, "the panel stayed open after the screen was made");
  });

  test("Create screen on step 1 makes a numbered wall display with no view", async () => {
    await mountScreens();
    await click(screen.getByRole("button", { name: /Add a screen/ }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs", body: { name: "Display 4", mode: "display" } }]);
  });
});

describe("a device waiting to be set up", () => {
  const DEVICE = { id: "kiosk-aaaa", macs: [], hostname: "lobby-pi", os: "linux", ip: "192.0.2.10", firstSeen: 1, lastSeen: 2 };

  beforeEach(() => { seenDevices = [DEVICE]; });

  test("Set up as a new screen opens the panel for it and claims NOTHING yet", async () => {
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    assert.ok(panel().getByText("New screen · step 1 of 3"));
    assert.ok(panel().getByText("Nothing is created until you finish. The device then shows this screen."));
    assert.deepEqual(writes.filter((w) => w.url === "/api/devices/claim"), [], "the device was claimed by opening the panel");
  });

  test("closing it midway leaves no screen and no claim", async () => {
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    await click(panel().getByRole("button", { name: "Next" }));
    await click(panel().getByRole("button", { name: "Close" }));
    assert.deepEqual(writes.filter((w) => w.url === "/api/devices/claim" || w.url === "/api/outputs"), []);
  });

  test("Create screen claims it with the answers, named for the device by default", async () => {
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    await click(panel().getByRole("button", { name: /^Control surface/ }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    const claims = writes.filter((w) => w.url === "/api/devices/claim");
    assert.deepEqual(claims, [{
      method: "POST",
      url: "/api/devices/claim",
      body: { deviceId: "kiosk-aaaa", outputId: null, name: "lobby-pi", mode: "panel" },
    }]);
    assert.equal(writes.filter((w) => w.url === "/api/outputs").length, 0, "the screen was made through the add route, not the claim");
    assert.equal(screen.queryByRole("complementary", { name: "Screen settings" }) !== null, false, "it is on screen");
  });

  test("a claim the server refuses keeps the panel open with the reason", async () => {
    claimFails = '"/history" is a built-in page.';
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.match(panel().getByRole("alert").textContent ?? "", /built-in page/);
    assert.ok(screen.getByRole("complementary", { name: "Screen settings" }));
  });

  test("Use for an existing screen is unchanged: it claims straight onto that screen", async () => {
    await mountScreens();
    await screen.findByRole("button", { name: "Set up as a new screen" });
    const pick = screen.getAllByRole("combobox").find((c) => (c as HTMLSelectElement).textContent?.includes("Use for an existing screen"))!;
    await choose(pick, "display-3");
    assert.deepEqual(
      writes.filter((w) => w.url === "/api/devices/claim"),
      [{ method: "POST", url: "/api/devices/claim", body: { deviceId: "kiosk-aaaa", outputId: "display-3" } }],
    );
  });
});
