// The Screens page's side panel and its cards, from the click to the server,
// through the real Screens route.
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
// beside the cards, the selected card's border, the corner expand button's
// hover reveal, a header drag reordering, and a real kiosk device announcing
// itself. jsdom loads no stylesheet and measures nothing.

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
const { PageActionsProvider, PageActionsSlot } = await import("../page-actions.js");
const { PANEL_OPEN_KEY } = await import("./use-panel-open.js");

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
/** Answer DELETE /api/views/:id with a refusal, to show the second half of a removal failing. */
let viewDeleteFails: boolean;
/** A create naming a view is refused as if the view had just become this kind: the stub's
 *  view flips to it and the answer is the server's 409. Null: creates go through. */
/** Devices the server holds as bound, and a gate on reading them back. */
let boundDevices: unknown[];
let deviceReadHeld: Promise<void> | null;
let stateReadHeld: Promise<void> | null;
/** Another operator adds a screen at the same moment as this page does. */
let otherOperatorAdds: boolean;
let viewShownByServer: { id: string; name: string }[] | null;
let surfaceMovedTo: "display" | "console" | null;
/** The page's query client, so a test can land a stage-state broadcast. */
let client: InstanceType<typeof QueryClient>;

beforeEach(() => {
  outputs = [
    { id: "display-1", name: "Booth panel", viewId: "ctl-a" },
    { id: "display-2", name: "Stage panel", viewId: "ctl-a" },
    { id: "display-3", name: "Lobby TV", viewId: "wall-a" },
  ];
  views = [WALL, CONSOLE];
  seenDevices = [];
  writes = [];
  claimFails = null;
  viewDeleteFails = false;
  surfaceMovedTo = null;
  viewShownByServer = null;
  otherOperatorAdds = false;
  boundDevices = [];
  deviceReadHeld = null;
  stateReadHeld = null;
  // The panel's open state is remembered per browser, so one test's close must not
  // be the next test's starting point.
  localStorage.clear();
  fetchStub = stubFetchWithLog((url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      // Only the writes that change a screen, a view or a claim. The page also
      // keeps a device scan alive and (re)subscribes to its event channels while
      // it is open, and neither is a change to anything.
      if (/^\/api\/(outputs|views|devices\/claim)/.test(url)) writes.push({ method, url, body });
      if (url === "/api/devices/claim" && claimFails) return reply(400, { error: claimFails });
      // The writes that change what the page lists, answered the way the server does.
      if (method === "POST" && (url === "/api/outputs" || url === "/api/devices/claim") && surfaceMovedTo) {
        const moved = surfaceMovedTo;
        views = views.map((v) => (v.id === (body as CreateBody).viewId ? { ...v, surface: moved } : v));
        return reply(409, { error: "The view changed while you were deciding: it is now. Nothing was changed.", code: "surface-changed", surface: moved });
      }
      if (method === "POST" && url === "/api/outputs") {
        const made = makeScreen(body as CreateBody);
        // Another operator adds a screen in the same moment, and lands after ours.
        if (otherOperatorAdds) outputs = [...outputs, { id: "display-99", name: "Their screen", viewId: null }];
        return ok({ ...state(), outputId: made });
      }
      if (method === "POST" && url === "/api/devices/claim" && (body as { outputId?: string | null }).outputId === null) {
        const made = makeScreen(body as CreateBody);
        boundDevices = [...boundDevices, { id: (body as { deviceId: string }).deviceId, outputId: made, macs: [], hostname: "lobby-pi" }];
        return ok({ ok: true, displaced: null, outputId: made });
      }
      if (method === "POST" && url === "/api/views") {
        const b = body as { name: string; kind: View["kind"]; surface?: View["surface"] };
        views = [...views, { id: `view-new-${views.length}`, name: b.name, kind: b.kind, surface: b.surface ?? "display", createdAt: NOW }];
      }
      if (method === "DELETE" && url.startsWith("/api/outputs/")) outputs = outputs.filter((o) => o.id !== url.split("/").pop());
      if (method === "DELETE" && url.startsWith("/api/views/")) {
        if (viewDeleteFails) return reply(500, { error: "the view is locked" });
        const [path, query] = url.split("?");
        // The server's own answer to a delete that must not touch a view a screen
        // shows: it knows of a screen the page does not (nothing here updates the page's state).
        if (query === "ifUnshown=1" && viewShownByServer) {
          return reply(409, { error: "The view was kept.", code: "view-shown", screens: viewShownByServer });
        }
        const gone = path.split("/").pop();
        views = views.filter((v) => v.id !== gone);
        outputs = outputs.map((o) => (o.viewId === gone ? { ...o, viewId: null } : o));
      }
      // Answer with the state as it stands: what these tests assert is the
      // REQUEST. The optimistic handlers reconcile to whatever comes back.
      return ok(state());
    }
    if (url === "/api/state") return stateReadHeld ? stateReadHeld.then(() => ok(state())) : ok(state());
    if (url === "/api/messages") return ok({ rev: 1, groups: [STAGE_GROUP], messages: [], alerts: [] });
    if (url.startsWith("/api/devices")) {
      // The server's answer after a claim lists the device as bound; `deviceReadHeld`
      // keeps that answer from arriving, to look at the form meanwhile.
      const answer = () => ok({ scanning: false, seen: seenDevices, matches: {}, bound: boundDevices, error: null });
      return deviceReadHeld ? deviceReadHeld.then(answer) : answer();
    }
    if (url === "/api/layout-templates" || url === "/api/presets" || url === "/api/integrations/wireless/channels") return ok([]);
    return ok({});
  });
});

const state = () => ({ ...DEFAULT_STAGE_STATE, outputs, views });

type CreateBody = { name?: string; viewId?: string; newView?: "wall" | "control" };
/** What POST /api/outputs and a claim of a new screen do to the lists; returns the new id. */
function makeScreen(body: CreateBody): string {
  const id = `display-${outputs.length + 10}`;
  const name = body.name ?? `Display ${outputs.length + 10}`;
  let viewId: string | null = body.viewId ?? null;
  if (body.newView) {
    viewId = `view-made-${id}`;
    views = [...views, { id: viewId, name, kind: "custom", surface: body.newView === "control" ? "console" : "display", createdAt: NOW }];
  }
  outputs = [...outputs, { id, name, viewId }];
  return id;
}

async function mountScreens() {
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const screens = createRoute({ getParentRoute: () => root, path: "/screens", component: ScreensRoute });
  const editor = createRoute({ getParentRoute: () => root, path: "/screens/$viewId/edit", component: () => React.createElement("p", null, "The layout editor") });
  const messages = createRoute({
    getParentRoute: () => root,
    path: "/settings/messages",
    component: () => React.createElement("p", null, "Messages settings"),
  });
  const router = createRouter({
    routeTree: root.addChildren([screens, editor, messages]),
    history: createMemoryHistory({ initialEntries: ["/screens"] }),
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TooltipProvider,
        null,
        // The shell's slot, where the page puts its Settings button.
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

const panel = () => within(screen.getByRole("complementary", { name: "Settings" }));
const panelIsOpen = () => screen.queryByRole("complementary", { name: "Settings" }) !== null;
/** The Add a screen tile among the cards (the panel's empty state has its own button of the same name). */
const addTile = () => screen.getAllByRole("button", { name: /Add a screen/ }).find((b) => !b.closest("aside"))!;
const toggle = () => screen.getByRole("button", { name: "Settings" });
const sw = (name: string) => panel().getByRole("switch", { name });
const answerConfirm = async (label: string) => {
  const dialog = await screen.findByRole("alertdialog");
  await click(within(dialog).getByRole("button", { name: label }));
};

describe("the panel and its Settings button", () => {
  test("is open on arrival with nothing selected, and says so", async () => {
    await mountScreens();
    assert.ok(panel().getByText("Nothing selected"));
    assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }));
    assert.ok(panel().getByText("Click any card on the left to see its settings here."));
    assert.equal(toggle().getAttribute("aria-pressed"), "true");
  });

  test("Settings closes it and opens it again, and the choice is kept for the next visit", async () => {
    await mountScreens();
    await click(toggle());
    assert.equal(panelIsOpen(), false, "the panel is still there");
    assert.equal(toggle().getAttribute("aria-pressed"), "false");
    assert.equal(localStorage.getItem(PANEL_OPEN_KEY), "0");
    cleanup();
    await mountScreens();
    assert.equal(panelIsOpen(), false, "a closed panel opened on the next visit");
    await click(toggle());
    assert.equal(localStorage.getItem(PANEL_OPEN_KEY), "1");
    cleanup();
    await mountScreens();
    assert.ok(panelIsOpen(), "an open panel was closed on the next visit");
  });

  test("storage that throws does not stop the page: the panel is open, and still toggles", async () => {
    const real = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error("storage is off"); };
    Storage.prototype.setItem = () => { throw new Error("storage is off"); };
    try {
      await mountScreens();
      assert.ok(panelIsOpen());
      await click(toggle());
      assert.equal(panelIsOpen(), false);
    } finally {
      Storage.prototype.getItem = real;
      Storage.prototype.setItem = realSet;
    }
  });

  test("on a viewport too narrow to dock it, nothing stored means closed; what the operator chose wins", async () => {
    const win = window as unknown as { matchMedia?: unknown };
    const had = win.matchMedia;
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    try {
      await mountScreens();
      assert.equal(panelIsOpen(), false, "an overlay panel covered a phone on arrival");
      cleanup();
      localStorage.setItem(PANEL_OPEN_KEY, "1");
      await mountScreens();
      assert.ok(panelIsOpen(), "a stored choice to keep it open was ignored");
    } finally {
      win.matchMedia = had;
    }
  });

  test("Screen settings… in a card's menu opens THAT screen's settings", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    assert.ok(panel().getByText("Screen settings"));
    assert.ok(panel().getByRole("heading", { name: "Lobby TV" }));
  });

  test("Screen settings… opens a closed panel", async () => {
    await mountScreens();
    await click(toggle());
    await openSettings("Lobby TV");
    assert.ok(panel().getByRole("heading", { name: "Lobby TV" }));
    assert.equal(toggle().getAttribute("aria-pressed"), "true");
  });

  test("focus ends up in the panel, not back on the card's menu button", async () => {
    // Radix hands focus back to a menu's trigger as the menu closes, and that
    // happens AFTER the panel has mounted and taken focus.
    await mountScreens();
    await openSettings("Lobby TV");
    await act(async () => { await settle(); await settle(); });
    const aside = screen.getByRole("complementary", { name: "Settings" });
    assert.equal(aside.contains(document.activeElement), true, `focus is on ${document.activeElement?.tagName} "${document.activeElement?.getAttribute("aria-label")}"`);
  });

  test("a screen removed while its settings are open leaves the empty state, with the panel still open", async () => {
    // Removed here or from another browser: the broadcast state no longer has it.
    await mountScreens();
    await openSettings("Lobby TV");
    outputs = outputs.filter((o) => o.id !== "display-3");
    await act(async () => { client.setQueryData(["stage:getState"], state()); await settle(); await settle(); });
    assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }), "the panel kept a form for a screen that is gone");
  });

  test("the X closes it and sends nothing", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(panel().getByRole("button", { name: "Close" }));
    assert.equal(panelIsOpen(), false, "it is on screen");
    assert.deepEqual(writes, []);
  });
});

describe("the panel follows the click, only while it is open", () => {
  /** A card, by the screen's name: the element carrying its own controls. */
  const card = (name: string) => screen.getByLabelText(`More actions for ${name}`).closest("div.flex.flex-col") as HTMLElement;

  test("a click on a card moves the panel to that screen", async () => {
    await mountScreens();
    await click(card("Lobby TV"));
    assert.ok(panel().getByRole("heading", { name: "Lobby TV" }));
    await click(card("Booth panel"));
    assert.ok(panel().getByRole("heading", { name: "Booth panel" }));
  });

  test("a click on the name focuses it for renaming AND moves the panel", async () => {
    await mountScreens();
    const name = within(card("Lobby TV")).getByLabelText("Display name");
    await act(async () => { (name as HTMLElement).focus(); fireEvent.click(name); await settle(); });
    assert.ok(panel().getByRole("heading", { name: "Lobby TV" }));
    assert.equal(document.activeElement, name, "the click moved focus off the name field");
  });

  test("a click on the card's own controls does not: the view picker, Open, the menu", async () => {
    await mountScreens();
    const lobby = card("Lobby TV");
    await click(within(lobby).getByRole("link", { name: /Open/ }));
    await click(within(lobby).getByLabelText("View on Lobby TV"));
    await click(within(lobby).getByLabelText("More actions for Lobby TV"));
    assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }), "a control moved the panel");
  });

  test("an item pressed in a card's menu (rendered in a portal) does not move the panel: Refresh is not a click on the card", async () => {
    await mountScreens();
    await click(card("Booth panel"));
    assert.ok(panel().getByRole("heading", { name: "Booth panel" }));
    const trigger = screen.getByLabelText("More actions for Lobby TV");
    await act(async () => { fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false }); fireEvent.click(trigger); await settle(); });
    await pressMenuItem("Refresh display");
    assert.ok(panel().getByRole("heading", { name: "Booth panel" }), "pressing a menu item moved the panel to the card the menu belongs to");
  });

  test("a card's picker change does not move it either", async () => {
    await mountScreens();
    await choose(within(card("Lobby TV")).getByLabelText("View on Lobby TV"), "wall-a");
    assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }));
  });

  test("with the panel closed a click on a card does nothing: it stays closed and nothing retargets", async () => {
    await mountScreens();
    await click(toggle());
    await click(card("Lobby TV"));
    assert.equal(panelIsOpen(), false, "a click opened the closed panel");
    // Opening it now shows nothing selected: the click selected nothing.
    await click(toggle());
    assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }), "a closed panel was retargeted by a click");
  });

  test("a view card under Views not on a screen moves the panel to its View settings", async () => {
    views = [...views, { id: "spare", name: "Spare loop", kind: "custom", surface: "display", createdAt: NOW }];
    await mountScreens();
    const spare = screen.getByLabelText("More actions for Spare loop").closest("div.flex.flex-col") as HTMLElement;
    await click(spare);
    assert.ok(panel().getByText("View settings"));
    assert.ok(panel().getByRole("heading", { name: "Spare loop" }));
  });

  test("a view card's name field still renames, and the click moves the panel too", async () => {
    views = [...views, { id: "spare", name: "Spare loop", kind: "custom", surface: "display", createdAt: NOW }];
    await mountScreens();
    const name = screen.getByLabelText("View name") as HTMLInputElement;
    await act(async () => { name.focus(); fireEvent.click(name); await settle(); });
    assert.ok(panel().getByRole("heading", { name: "Spare loop" }));
    await type(name, "Spare loop 2");
    await act(async () => { fireEvent.blur(name); await settle(); await settle(); });
    assert.deepEqual(writes.filter((w) => w.method === "PATCH"), [{ method: "PATCH", url: "/api/views/spare", body: { name: "Spare loop 2" } }]);
  });

  test("the selected card says so, and only while the panel is open", async () => {
    await mountScreens();
    await click(card("Lobby TV"));
    assert.match(card("Lobby TV").className, /border-accent/);
    assert.doesNotMatch(card("Booth panel").className, /border-accent/);
    await click(toggle());
    assert.doesNotMatch(card("Lobby TV").className, /border-accent/, "a closed panel still marks a card");
  });
});

describe("the preview", () => {
  const previewOf = (name: string) => screen.getByLabelText(`More actions for ${name}`).closest("div.flex.flex-col") as HTMLElement;
  let opened: [string | undefined, string | undefined][];
  const realOpen = window.open;
  beforeEach(() => {
    opened = [];
    window.open = ((url?: string | URL, target?: string) => { opened.push([String(url), target]); return null; }) as typeof window.open;
  });
  afterEach(() => { window.open = realOpen; });
  const here = () => (document.body.textContent ?? "").includes("The layout editor");

  test("panel closed: the preview goes to the layout editor, as it always did", async () => {
    await mountScreens();
    await click(toggle());
    await click(await within(previewOf("Lobby TV")).findByRole("button", { name: "Edit what Lobby TV shows" }));
    assert.equal(here(), true, "the preview did not open the editor");
  });

  test("panel open: a plain click moves the panel and does not leave the page", async () => {
    await mountScreens();
    await click(await within(previewOf("Lobby TV")).findByRole("button", { name: "Show settings for Lobby TV" }));
    assert.ok(panel().getByRole("heading", { name: "Lobby TV" }));
    assert.equal(here(), false, "a plain click on the preview left for the editor");
    assert.deepEqual(opened, [], "a plain click on the preview opened the display");
  });

  /** Report this platform to the page, as a browser does. */
  const asPlatform = (platform: string) => Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
  afterEach(() => { Reflect.deleteProperty(navigator, "platform"); });

  // Cmd opens a link in a new tab on a Mac, where Ctrl-click is a right click; Ctrl
  // does everywhere else, and Shift both.
  for (const [platform, mod, opensIt] of [
    ["MacIntel", "metaKey", true], ["MacIntel", "shiftKey", true], ["MacIntel", "ctrlKey", false],
    ["Win32", "ctrlKey", true], ["Win32", "shiftKey", true], ["Win32", "metaKey", false],
    ["Linux x86_64", "ctrlKey", true],
  ] as const) {
    test(`panel open on ${platform}: a ${mod} click ${opensIt ? "opens the display and does not move the panel" : "is a plain click: it moves the panel and opens nothing"}`, async () => {
      asPlatform(platform);
      await mountScreens();
      const preview = await within(previewOf("Lobby TV")).findByRole("button", { name: "Show settings for Lobby TV" });
      await act(async () => { fireEvent.click(preview, { [mod]: true }); await settle(); });
      if (opensIt) {
        assert.deepEqual(opened, [[`${window.location.origin}/display-3`, "display-display-3"]]);
        assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }), "a modified click also moved the panel");
      } else {
        assert.deepEqual(opened, [], `${mod} opened the display on ${platform}`);
        assert.ok(panel().getByRole("heading", { name: "Lobby TV" }), "a plain click did not move the panel");
      }
    });
  }

  test("panel open: a middle click opens the display too", async () => {
    await mountScreens();
    const preview = await within(previewOf("Lobby TV")).findByRole("button", { name: "Show settings for Lobby TV" });
    await act(async () => { fireEvent(preview, new window.MouseEvent("auxclick", { bubbles: true, button: 1 })); await settle(); });
    assert.deepEqual(opened, [[`${window.location.origin}/display-3`, "display-display-3"]]);
  });

  test("panel open: the preview's own expand button still goes to the editor, and does not move the panel", async () => {
    await mountScreens();
    await click(await within(previewOf("Lobby TV")).findByRole("button", { name: "Edit what Lobby TV shows" }));
    assert.equal(here(), true, "the expand button did not open the editor");
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

describe("choosing a view of the other kind in the panel", () => {
  // The view decides what a screen is, so there is no role route: the answer to
  // the question is one PATCH of the screen's viewId, and nothing else moves.
  test("a control surface pointed at a wall view asks, then PATCHes viewId with the kind it asked about", async () => {
    await mountScreens();
    await openSettings("Booth panel");
    await choose(panel().getByLabelText("View"), "wall-a");
    assert.deepEqual(writes, [], "the screen was routed before the operator said yes");
await answerConfirm("Show it");
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-1", body: { viewId: "wall-a", expectSurface: "display" } }]);
  });

  test("a wall display pointed at a console asks, then PATCHes viewId with the kind it asked about", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await choose(panel().getByLabelText("View"), "ctl-a");
await answerConfirm("Show it and make it live");
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { viewId: "ctl-a", expectSurface: "console" } }]);
  });

  test("declining sends nothing", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await choose(panel().getByLabelText("View"), "ctl-a");
    await answerConfirm("Cancel");
    assert.deepEqual(writes, []);
  });
});

describe("the card's own view picker", () => {
  /** The view picker on this screen's card: the nearest select above its menu. */
  function cardPicker(screenName: string): HTMLSelectElement {
    let el: HTMLElement | null = screen.getByLabelText(`More actions for ${screenName}`);
    while (el && !el.querySelector("select")) el = el.parentElement;
    return el!.querySelector("select")!;
  }

  test("choosing a console for a wall display asks, then points the screen at it: one PATCH of viewId and the kind asked about", async () => {
    // Lobby TV shares its wall view with another screen. Choosing a view is all
    // it takes to make it a control surface, and the other screen, which keeps the
    // wall view, is not touched.
    outputs = [...outputs, { id: "display-4", name: "Hallway TV", viewId: "wall-a" }];
    await mountScreens();
    await choose(cardPicker("Lobby TV"), "ctl-a");
    assert.deepEqual(writes, [], "the screen was routed before the operator said yes");
await answerConfirm("Show it and make it live");
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-3", body: { viewId: "ctl-a", expectSurface: "console" } }]);
  });

  test("declining the confirm assigns nothing", async () => {
    await mountScreens();
    await choose(cardPicker("Lobby TV"), "ctl-a");
    const dialog = await screen.findByRole("alertdialog");
    await click(within(dialog).getByRole("button", { name: "Cancel" }));
    assert.deepEqual(writes, []);
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
    outputs = [{ id: "display-1", name: "Lobby TV", viewId: "ctl-a" }];
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
  const nextStep = () => click(panel().getByRole("button", { name: "Next" }));

  test("opens the panel on step 1 of 2 and creates NOTHING", async () => {
    await mountScreens();
    await click(addTile());
    assert.ok(panel().getByText("New screen · step 1 of 2"));
    assert.deepEqual(writes, [], "a screen was created by opening the panel");
  });

  test("the panel's own + Add a screen starts it too, and opens a closed panel", async () => {
    await mountScreens();
    await click(panel().getByRole("button", { name: "+ Add a screen" }));
    assert.ok(panel().getByText("New screen · step 1 of 2"));
    await click(panel().getByRole("button", { name: "Close" }));
    await click(addTile());
    assert.ok(panel().getByText("New screen · step 1 of 2"), "the tile did not open a closed panel");
  });

  test("closing it midway leaves no screen, and opening it again does not bring the half-made one back", async () => {
    await mountScreens();
    await click(addTile());
    await nextStep();
    await click(panel().getByRole("button", { name: /^A new control surface/ }));
    await click(panel().getByRole("button", { name: "Close" }));
    assert.equal(panelIsOpen(), false, "it is on screen");
    assert.deepEqual(writes, []);
    await click(toggle());
    assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }), "a half-made screen came back");
  });

  test("Create screen is on step 2 only; the default sends newView: wall, and the panel STAYS on the new screen", async () => {
    await mountScreens();
    await click(addTile());
    assert.equal(panel().queryByRole("button", { name: "Create screen" }) !== null, false, "Create screen is on step 1");
    await type(panel().getByLabelText("Name"), "Wing");
    await nextStep();
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs", body: { name: "Wing", newView: "wall" } }]);
    assert.ok(panelIsOpen(), "the panel closed after the screen was made");
    assert.ok(panel().getByText("Screen settings"), "the panel did not move to the new screen");
    assert.ok(panel().getByRole("heading", { name: "Wing" }));
    const note = panel().getByRole("status");
    assert.match(note.textContent ?? "", /Created "Wing" and its view\. The view is blank until you lay it out\./);
    // Edit layout in the note goes to the new view's editor.
    await click(within(note).getByRole("button", { name: "Edit layout" }));
    assert.ok((document.body.textContent ?? "").includes("The layout editor"), "Edit layout did not open the editor");
  });

  test("the panel lands on the screen THIS call made, not one another operator added at the same moment", async () => {
    otherOperatorAdds = true;
    await mountScreens();
    await click(addTile());
    await type(panel().getByLabelText("Name"), "Wing");
    await nextStep();
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.ok(panel().getByRole("heading", { name: "Wing" }), "the panel opened on the other operator's screen");
  });

  test("a new control surface POSTs newView: control", async () => {
    await mountScreens();
    await click(addTile());
    await nextStep();
    await click(panel().getByRole("button", { name: /^A new control surface/ }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs", body: { newView: "control" } }]);
  });

  test("a view you already have POSTs its id, and the note has no Edit layout of its own: no view was made", async () => {
    await mountScreens();
    await click(addTile());
    await nextStep();
    await click(panel().getByRole("button", { name: /^A view you already have/ }));
    await choose(panel().getByLabelText("Existing view"), "wall-a");
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs", body: { viewId: "wall-a", expectSurface: "display" } }]);
    const note = panel().getByRole("status");
    assert.doesNotMatch(note.textContent ?? "", /and its view/);
    assert.equal(within(note).queryByRole("button", { name: "Edit layout" }) !== null, false, "it is on screen");
  });

  test("a view that turned into the other kind meanwhile is a 409: no screen, step 2 stays, and the role line is reloaded", async () => {
    surfaceMovedTo = "console";
    await mountScreens();
    await click(addTile());
    await nextStep();
    await click(panel().getByRole("button", { name: /^A view you already have/ }));
    await choose(panel().getByLabelText("Existing view"), "wall-a");
    assert.ok(panel().getByText("Wall display"), "the role line did not start on the wall kind");
    await click(panel().getByRole("button", { name: "Create screen" }));
    await act(async () => { await settle(); await settle(); await settle(); });
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs", body: { viewId: "wall-a", expectSurface: "display" } }]);
    assert.match(panel().getByRole("alert").textContent ?? "", /The view changed while you were deciding/);
    assert.ok(panel().getByRole("heading", { name: "What should it show?" }), "the panel left step 2");
    assert.equal(outputs.length, 3, "a screen was made");
    assert.ok(panel().getByText("Control surface"), "the role line did not follow the view to its new kind");
    // Create again: now it sends the kind the line shows.
    surfaceMovedTo = null;
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.deepEqual(writes.at(-1), { method: "POST", url: "/api/outputs", body: { viewId: "wall-a", expectSurface: "console" } });
  });

  test("Nothing yet POSTs no view at all", async () => {
    await mountScreens();
    await click(addTile());
    await nextStep();
    await click(panel().getByRole("button", { name: /^Nothing yet/ }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.deepEqual(writes, [{ method: "POST", url: "/api/outputs", body: {} }]);
  });

  test("the note is gone once the operator points the panel somewhere else", async () => {
    await mountScreens();
    await click(addTile());
    await nextStep();
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.ok(panel().getByRole("status"));
    await click(screen.getByLabelText("More actions for Lobby TV").closest("div.flex.flex-col") as HTMLElement);
    await click(panel().getByRole("button", { name: "View settings →" }));
    await click(panel().getByRole("button", { name: /^Lobby TV$/ }));
    assert.equal(panel().queryByRole("status") !== null, false, "the note outlived the selection");
  });
});

/** Open a card's menu and press Remove display…. */
async function removeFromMenu(screenName: string): Promise<void> {
  const trigger = screen.getByLabelText(`More actions for ${screenName}`);
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settle();
  });
  await pressMenuItem("Remove display…");
}
const dialog = async () => within(await screen.findByRole("alertdialog"));

describe("removing a screen", () => {
  test("from the card's menu: asks first, and the dialog is centred and names the screen", async () => {
    await mountScreens();
    await removeFromMenu("Lobby TV");
    assert.deepEqual(writes, [], "the screen was removed before the operator said yes");
    const d = await dialog();
    assert.ok(d.getByText('Remove "Lobby TV"?'));
    assert.ok(d.getByText("Its address and settings go away. This cannot be undone."));
    assert.ok(d.getByRole("button", { name: "Remove screen" }));
  });

  test("a screen alone on its view offers 'Also delete its view', UNTICKED, with its sub-line", async () => {
    await mountScreens();
    await removeFromMenu("Lobby TV");
    const d = await dialog();
    const box = d.getByRole("checkbox");
    assert.equal(box.getAttribute("aria-checked"), "false", "the view is deleted by default");
    assert.ok(d.getByText('Also delete its view, "Lobby loop"'));
    assert.ok(d.getByText("Nothing else shows it. Left unticked, it moves to Views not on a screen."));
  });

  test("left unticked it removes the screen and only the screen", async () => {
    await mountScreens();
    await removeFromMenu("Lobby TV");
    await answerConfirm("Remove screen");
    assert.deepEqual(writes, [{ method: "DELETE", url: "/api/outputs/display-3", body: undefined }]);
  });

  test("ticked it says so on the button, and removes the screen THEN deletes the view", async () => {
    await mountScreens();
    await removeFromMenu("Lobby TV");
    const d = await dialog();
    await click(d.getByRole("checkbox"));
    assert.ok(d.getByRole("button", { name: "Remove screen and view" }));
    assert.equal(d.queryByRole("button", { name: "Remove screen" }) !== null, false, "the button still reads as the screen alone");
    await click(d.getByRole("button", { name: "Remove screen and view" }));
    assert.deepEqual(writes, [
      { method: "DELETE", url: "/api/outputs/display-3", body: undefined },
      { method: "DELETE", url: "/api/views/wall-a?ifUnshown=1", body: undefined },
    ]);
  });

  test("a screen whose view another screen shows has no checkbox, and names who keeps it", async () => {
    await mountScreens();
    await removeFromMenu("Booth panel");
    const d = await dialog();
    assert.equal(d.queryByRole("checkbox") !== null, false, "the view of a shared screen was offered for deletion");
    assert.ok(d.getByText('Its view, "Booth controls", stays: "Stage panel" also shows it.'));
    await click(d.getByRole("button", { name: "Remove screen" }));
    assert.deepEqual(writes, [{ method: "DELETE", url: "/api/outputs/display-1", body: undefined }]);
  });

  test("three or more other screens are listed, comma-separated", async () => {
    outputs = [...outputs, { id: "display-4", name: "Wing panel", viewId: "ctl-a" }, { id: "display-5", name: "Back panel", viewId: "ctl-a" }];
    await mountScreens();
    await removeFromMenu("Booth panel");
    const d = await dialog();
    assert.ok(d.getByText('Its view, "Booth controls", stays: "Stage panel", "Wing panel", "Back panel" also show it.'));
  });

  test("Cancel removes nothing", async () => {
    await mountScreens();
    await removeFromMenu("Lobby TV");
    await answerConfirm("Cancel");
    assert.deepEqual(writes, []);
  });

  test("the panel's footer asks the same question", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(panel().getByRole("button", { name: "Remove screen…" }));
    const d = await dialog();
    assert.ok(d.getByText('Remove "Lobby TV"?'));
    assert.ok(d.getByRole("checkbox"));
    await click(d.getByRole("checkbox"));
    await click(d.getByRole("button", { name: "Remove screen and view" }));
    assert.deepEqual(writes.map((w) => `${w.method} ${w.url}`), ["DELETE /api/outputs/display-3", "DELETE /api/views/wall-a?ifUnshown=1"]);
    // The screen is gone, so the panel has nothing to show.
    assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }));
  });

  test("the last screen cannot be removed from the footer", async () => {
    outputs = [outputs[2]];
    await mountScreens();
    await openSettings("Lobby TV");
    assert.equal((panel().getByRole("button", { name: "Remove screen…" }) as HTMLButtonElement).disabled, true);
  });

  test("when deleting the view fails the operator is told the screen is gone and the view is not", async () => {
    viewDeleteFails = true;
    await mountScreens();
    await removeFromMenu("Lobby TV");
    const d = await dialog();
    await click(d.getByRole("checkbox"));
    await click(d.getByRole("button", { name: "Remove screen and view" }));
    await act(async () => { await settle(); await settle(); });
    const toasts = document.body.textContent ?? "";
    assert.match(toasts, /Removed "Lobby TV", but its view "Lobby loop" was not deleted\./);
    assert.match(toasts, /Failed to remove view/, "the server's own reason was swallowed");
    assert.deepEqual(writes.map((w) => `${w.method} ${w.url}`), ["DELETE /api/outputs/display-3", "DELETE /api/views/wall-a?ifUnshown=1"]);
  });

  test("a view another screen was pointed at is NOT deleted: the server says so, the page's own state never showed it, and the operator is told", async () => {
    // The probe shape: nothing is pushed into the page's state. Only the server's
    // reply knows the Booth panel shows the view now.
    viewShownByServer = [{ id: "display-1", name: "Booth panel" }];
    await mountScreens();
    await removeFromMenu("Lobby TV");
    const d = await dialog();
    await click(d.getByRole("checkbox"));
    await click(d.getByRole("button", { name: "Remove screen and view" }));
    await act(async () => { await settle(); await settle(); });
    assert.deepEqual(writes.map((w) => `${w.method} ${w.url}`), ["DELETE /api/outputs/display-3", "DELETE /api/views/wall-a?ifUnshown=1"]);
    assert.match(document.body.textContent ?? "", /Removed "Lobby TV"\. Its view "Lobby loop" was kept: "Booth panel" now shows it\./);
  });
});

describe("View settings", () => {
  const card = (name: string) => screen.getByLabelText(`More actions for ${name}`).closest("div.flex.flex-col") as HTMLElement;

  test("a screen's View settings → opens its view's settings, and a chip jumps back to a screen", async () => {
    await mountScreens();
    await openSettings("Booth panel");
    await click(panel().getByRole("button", { name: "View settings →" }));
    assert.ok(panel().getByText("View settings"));
    assert.ok(panel().getByRole("heading", { name: "Booth controls" }));
    // Both screens that show it.
    await click(panel().getByRole("button", { name: "Stage panel" }));
    assert.ok(panel().getByText("Screen settings"));
    assert.ok(panel().getByRole("heading", { name: "Stage panel" }));
  });

  test("renaming the view PATCHes it", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(panel().getByRole("button", { name: "View settings →" }));
    const name = panel().getByLabelText("View name");
    await type(name, "Lobby wall");
    await act(async () => { fireEvent.blur(name); await settle(); await settle(); });
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/views/wall-a", body: { name: "Lobby wall" } }]);
  });

  test("a view that screens show goes through the confirm that names them before its kind changes", async () => {
    await mountScreens();
    await openSettings("Booth panel");
    await click(panel().getByRole("button", { name: "View settings →" }));
    await click(panel().getByRole("button", { name: /^Wall view/ }));
    const d = await dialog();
    assert.match(String(document.querySelector('[role="alertdialog"]')?.textContent), /"Booth panel" and "Stage panel" become read-only, and it leaves the sidebar/);
    assert.deepEqual(writes.map((w) => w.url), [], "the kind changed before the operator said yes");
    await click(d.getByRole("button", { name: /^Make (it|them)/ }));
    assert.deepEqual(writes.map((w) => w.url), ["/api/views/ctl-a/surface"]);
  });

  test("Duplicate makes a copy and the panel moves to it", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await click(panel().getByRole("button", { name: "View settings →" }));
    // The server answers a duplicate with the state including the copy.
    const dup = async () => { views = [...views, { ...WALL, id: "wall-copy", name: "Lobby loop copy" }]; };
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/duplicate")) await dup();
      return stub(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      await click(panel().getByRole("button", { name: "Duplicate" }));
    } finally {
      globalThis.fetch = stub;
    }
    assert.ok(panel().getByRole("heading", { name: "Lobby loop copy" }), "the panel stayed on the original");
  });

  test("Delete view… names every screen showing it, then deletes it", async () => {
    await mountScreens();
    await openSettings("Booth panel");
    await click(panel().getByRole("button", { name: "View settings →" }));
    await click(panel().getByRole("button", { name: "Delete view…" }));
    const d = await dialog();
    assert.ok(d.getByText('Delete view "Booth controls"?'));
    assert.ok(d.getByText("Its layout goes with it. This cannot be undone."));
    assert.ok(d.getByText('"Booth panel" and "Stage panel" show it, and will show nothing until you pick another view. Their buttons stop working.'));
    assert.deepEqual(writes, []);
    await click(d.getByRole("button", { name: "Delete view" }));
    assert.deepEqual(writes, [{ method: "DELETE", url: "/api/views/ctl-a", body: undefined }]);
    // The view is gone, so the panel has nothing to show.
    assert.ok(panel().getByRole("heading", { name: "Select a screen or view" }));
  });

  test("Delete view… on a view no screen shows says nothing about screens", async () => {
    views = [...views, { id: "spare", name: "Spare loop", kind: "custom", surface: "display", createdAt: NOW }];
    await mountScreens();
    await click(card("Spare loop"));
    await click(panel().getByRole("button", { name: "Delete view…" }));
    const d = await dialog();
    assert.ok(d.getByText('Delete view "Spare loop"?'));
    assert.equal(/will show nothing/.test(document.body.textContent ?? ""), false, "a note about screens was shown for a view no screen shows");
  });

  test("Cancel deletes nothing", async () => {
    await mountScreens();
    await openSettings("Booth panel");
    await click(panel().getByRole("button", { name: "View settings →" }));
    await click(panel().getByRole("button", { name: "Delete view…" }));
    await answerConfirm("Cancel");
    assert.deepEqual(writes, []);
  });

  test("a control surface's card menu offers 'Make it a wall view', the word the rest of the page uses for a view's kind", async () => {
    views = [...views, { id: "spare-c", name: "Spare controls", kind: "custom", surface: "console", createdAt: NOW }];
    await mountScreens();
    await click(toggle());
    const trigger = screen.getByLabelText("More actions for Spare controls");
    await act(async () => { fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false }); fireEvent.click(trigger); await settle(); });
    assert.ok(screen.getByRole("menuitem", { name: "Make it a wall view" }));
    assert.equal(screen.queryByRole("menuitem", { name: /wall screen/ }) !== null, false, "the old label is back");
  });

  test("a view card's menu has View settings…, and it opens them", async () => {
    views = [...views, { id: "spare", name: "Spare loop", kind: "custom", surface: "display", createdAt: NOW }];
    await mountScreens();
    await click(toggle());
    const trigger = screen.getByLabelText("More actions for Spare loop");
    await act(async () => { fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false }); fireEvent.click(trigger); await settle(); });
    await pressMenuItem("View settings…");
    assert.ok(panel().getByRole("heading", { name: "Spare loop" }));
  });
});

describe("a new view from a card's picker", () => {
  const cardPicker = (screenName: string) => {
    let el: HTMLElement | null = screen.getByLabelText(`More actions for ${screenName}`);
    while (el && !el.querySelector("select")) el = el.parentElement;
    return el!.querySelector("select")!;
  };

  test("groups its views as wall views and control surfaces and ends with both ways to make one", async () => {
    await mountScreens();
    const picker = cardPicker("Lobby TV");
    assert.deepEqual([...picker.querySelectorAll("optgroup")].map((g) => g.label), ["Wall views", "Control surfaces"]);
    assert.deepEqual([...picker.options].slice(-2).map((o) => o.textContent), ["+ New wall view…", "+ New control surface…"]);
  });

  /** Fill the new-view dialog a picker entry opened, and create. */
  async function createViewNamed(name: string) {
    const dlg = await screen.findByRole("dialog");
    await type(within(dlg).getByPlaceholderText(/View name/), name);
    await click(within(dlg).getByRole("button", { name: "Create" }));
  }

  test("+ New control surface… on a wall screen creates one, then ASKS before pointing the screen at it", async () => {
    await mountScreens();
    await choose(cardPicker("Lobby TV"), "__new_control__");
    await createViewNamed("Lobby desk");
    const create = writes.find((w) => w.method === "POST" && w.url === "/api/views");
    assert.deepEqual(create?.body, { name: "Lobby desk", kind: "custom", surface: "console" });
    const d = await dialog();
    assert.ok(d.getByText('Make "Lobby TV" a control surface?'));
    assert.ok(d.getByText('"Lobby desk" is a control surface. Buttons on this screen will work, and anyone standing at it can press them.'));
    assert.equal(writes.some((w) => w.method === "PATCH"), false, "the screen was pointed at the view before the operator said yes");
    await click(d.getByRole("button", { name: "Show it and make it live" }));
    const patch = writes.find((w) => w.method === "PATCH");
    assert.equal(patch?.url, "/api/outputs/display-3");
    assert.match(String((patch?.body as { viewId: string }).viewId), /^view-new-/);
    // The server refuses when the view changed kind while the question was open.
    assert.equal((patch?.body as { expectSurface?: string }).expectSurface, "console");
  });

  test("declining leaves the view made and the screen where it was", async () => {
    await mountScreens();
    await choose(cardPicker("Lobby TV"), "__new_control__");
    await createViewNamed("Lobby desk");
    await answerConfirm("Cancel");
    assert.equal(writes.some((w) => w.method === "PATCH"), false);
  });

  test("+ New wall view… on a wall screen points it at the view straight away: nothing changes kind", async () => {
    await mountScreens();
    await choose(cardPicker("Lobby TV"), "__new_wall__");
    await createViewNamed("Lobby two");
    assert.equal(screen.queryByRole("alertdialog") !== null, false, "a confirm was asked for a change that changes nothing");
    const patch = writes.find((w) => w.method === "PATCH");
    assert.equal(patch?.url, "/api/outputs/display-3");
    assert.equal((patch?.body as { expectSurface?: string }).expectSurface, "display");
  });

  test("the panel's picker sends the kind it asked about too", async () => {
    await mountScreens();
    await openSettings("Lobby TV");
    await choose(panel().getByLabelText("View"), "__new_control__");
    await createViewNamed("Lobby desk");
    await answerConfirm("Show it and make it live");
    const patch = writes.find((w) => w.method === "PATCH");
    assert.equal(patch?.url, "/api/outputs/display-3");
    assert.equal((patch?.body as { expectSurface?: string }).expectSurface, "console");
  });
});

describe("a device waiting to be set up", () => {
  const DEVICE = { id: "kiosk-aaaa", macs: [], hostname: "lobby-pi", os: "linux", ip: "192.0.2.10", firstSeen: 1, lastSeen: 2 };

  beforeEach(() => { seenDevices = [DEVICE]; });

  test("Set up as a new screen opens the panel for it and claims NOTHING yet", async () => {
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    assert.ok(panel().getByText("New screen · step 1 of 2"));
    assert.ok(panel().getByText("Nothing is created until the last step. The device then shows this screen."));
    assert.deepEqual(writes.filter((w) => w.url === "/api/devices/claim"), [], "the device was claimed by opening the panel");
  });

  test("after the claim the panel stays on the screen that was made for the device", async () => {
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    await click(panel().getByRole("button", { name: "Next" }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    await act(async () => { await settle(); await settle(); });
    assert.ok(panel().getByText("Screen settings"));
    assert.ok(panel().getByRole("heading", { name: "lobby-pi" }));
    assert.match(panel().getByRole("status").textContent ?? "", /Created "lobby-pi" and its view/);
  });

  test("while its OWN claim is being read back the form does not say another operator took the device", async () => {
    // The claim bound the device to the screen this form just made, and the device
    // list read after it says so; the form is still up until the page's state has
    // the new screen. That is not somebody else's doing.
    let release!: () => void;
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    await click(panel().getByRole("button", { name: "Next" }));
    stateReadHeld = new Promise<void>((r) => { release = r; });
    await act(async () => { fireEvent.click(panel().getByRole("button", { name: "Create screen" })); await settle(); await settle(); await settle(); });
    assert.ok(writes.some((w) => w.url === "/api/devices/claim"), "the claim never went out");
    assert.ok(panel().getByRole("button", { name: "Create screen" }), "the form is gone before the state arrived: the window was not reached");
    assert.equal(/set up as .* meanwhile/.test(document.body.textContent ?? ""), false, "the form blamed another operator for its own claim");
    stateReadHeld = null;
    await act(async () => { release(); await settle(); await settle(); });
    assert.ok(panel().getByRole("heading", { name: "lobby-pi" }));
  });

  test("a claim for a view that turned into the other kind is a 409: step 2 stays and no screen is made", async () => {
    surfaceMovedTo = "console";
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    await click(panel().getByRole("button", { name: "Next" }));
    await click(panel().getByRole("button", { name: /^A view you already have/ }));
    await choose(panel().getByLabelText("Existing view"), "wall-a");
    await click(panel().getByRole("button", { name: "Create screen" }));
    await act(async () => { await settle(); await settle(); await settle(); });
    const claim = writes.find((w) => w.url === "/api/devices/claim");
    assert.deepEqual(claim?.body, { deviceId: "kiosk-aaaa", outputId: null, name: "lobby-pi", viewId: "wall-a", expectSurface: "display" });
    assert.match(panel().getByRole("alert").textContent ?? "", /The view changed while you were deciding/);
    assert.ok(panel().getByRole("heading", { name: "What should it show?" }));
    assert.equal(outputs.length, 3);
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
    await click(panel().getByRole("button", { name: "Next" }));
    await click(panel().getByRole("button", { name: /^A new control surface/ }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    const claims = writes.filter((w) => w.url === "/api/devices/claim");
    assert.deepEqual(claims, [{
      method: "POST",
      url: "/api/devices/claim",
      body: { deviceId: "kiosk-aaaa", outputId: null, name: "lobby-pi", newView: "control" },
    }]);
    assert.equal(writes.filter((w) => w.url === "/api/outputs").length, 0, "the screen was made through the add route, not the claim");
    assert.ok(panelIsOpen(), "the panel closed after the device was set up");
  });

  test("a claim the server refuses keeps the panel open with the reason", async () => {
    claimFails = '"/history" is a built-in page.';
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    await click(panel().getByRole("button", { name: "Next" }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    assert.match(panel().getByRole("alert").textContent ?? "", /built-in page/);
    assert.ok(screen.getByRole("complementary", { name: "Settings" }));
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
