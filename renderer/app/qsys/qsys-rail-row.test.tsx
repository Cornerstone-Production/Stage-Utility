// The Q-SYS row in the real rail: when it is drawn, what hovering, tapping and the
// keys do, and where choosing an item goes.
//
// NOT UNIT-TESTED, and why: jsdom loads no stylesheet and measures every box as 0.
// The flyout's position beside the rail, the transparent bridge that fills the gap
// to it, the highlight a CSS :hover paints, the 44 px touch targets and the flyout
// not being clipped by the scrolling sidebar are all geometry or CSS, so they
// cannot fail here. They were driven in a browser (see the task report). What this
// file pins is the part that is state: the 500 ms rule, that the pointer crossing
// into the flyout is not a leave, which row is current, the folder, the keys, and
// the visibility rule.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installDom, unmountAndTeardown } from "../../test-dom.js";

const teardown = installDom();

const listeners = new Map<string, Set<(e: { data: string }) => void>>();
class StubEventSource {
  readyState = 1;
  onopen: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  addEventListener(channel: string, handler: (e: { data: string }) => void): void {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(handler);
  }
  removeEventListener(channel: string, handler: (e: { data: string }) => void): void {
    listeners.get(channel)?.delete(handler);
  }
  close(): void {
    this.readyState = 2;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};
(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

const LAYOUT = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };
const panel = (id: string, slug: string, name: string, kind: "volunteer" | "staff") =>
  ({ id, name, kind: "custom", surface: "console", createdAt: "", layout: LAYOUT, qsys: { kind, slug, siblings: [], returnAfterMin: 5 } });
const PANELS = [panel("v1", "zone-1", "Zone 1", "volunteer"), panel("v2", "booth", "Booth", "staff")];
const PLAIN = { id: "view-foh", name: "FOH", kind: "custom", surface: "console", createdAt: "" };

type Sidebar = { sections: { id: string; label: string; kind: string; members: string[] }[]; hidden: string[] };
let state: { views: unknown[]; outputs: unknown[]; appName: string; sidebar: Sidebar };
let configured = false;

const json = (status: number, value: unknown) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const path = String(input);
  if (path.startsWith("/api/state")) return json(200, state);
  if (path === "/api/qsys/status") return json(200, { connected: false, state: "offline", designName: null, isEmulator: null, configured });
  return json(200, {});
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Rail } = await import("../rail.js");
const { CustomizeProvider } = await import("../customize-mode.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { SidebarChromeProvider } = await import("../../components/ui/sidebar.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");
const { DEFAULT_SIDEBAR } = await import("@main/services/sidebar-arrangement");
const { QSYS_FLYOUT_DELAY_MS } = await import("./qsys-rail-row.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  state = { views: [PLAIN, ...PANELS], outputs: [], appName: "Rail test app", sidebar: { sections: [], hidden: [] } };
  configured = false;
});
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
  listeners.clear();
});

let where = (): string => "";

async function mount(at = "/", closeDrawer?: () => void): Promise<HTMLElement> {
  const root = createRootRoute({
    component: () =>
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(
            SidebarChromeProvider,
            {
              value: { collapsed: false, isMobile: closeDrawer !== undefined, ...(closeDrawer ? { closeDrawer } : {}) },
              children: React.createElement(CustomizeProvider, null, React.createElement(Rail, { onToggleCollapsed() {}, dragging: false, onStartResize() {}, onResetWidth() {} })),
            },
          ),
        ),
      ),
  });
  const r = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [at] }) });
  where = () => r.state.location.pathname;
  const { container } = render(React.createElement(RouterProvider, { router: r }));
  await eventually(() => assert.ok((container.textContent ?? "").includes("Rail test app"), "the rail never read the state"));
  return container;
}

const rowWrapper = () => document.querySelector<HTMLElement>("[data-qsys-rail-row]");
const rowButton = () => rowWrapper()?.querySelector<HTMLButtonElement>("button") ?? null;
const flyout = () => document.querySelector<HTMLElement>("[data-qsys-flyout]");
const folder = () => document.querySelector<HTMLElement>("[data-qsys-folder]");
/** Real time passing, inside act so what it lets land is not reported as unwrapped. */
const wait = (ms: number) => act(async () => void (await new Promise<void>((r) => setTimeout(r, ms))));
const mouse = { pointerType: "mouse" } as const;
const hover = () => act(async () => void fireEvent.pointerOver(rowWrapper()!, mouse));
const labels = (el: Element | null) => [...(el?.querySelectorAll("button") ?? [])].map((b) => (b.textContent ?? "").trim());

describe("the Q-SYS row is drawn only when it has something to open", () => {
  test("a panel alone draws it; a Core set up alone draws it; neither does not", async () => {
    await mount();
    assert.ok(rowButton(), "a panel exists and there is no row");
    cleanup();
    resetStageState();
    state.views = [PLAIN];
    configured = true;
    await mount();
    await eventually(() => assert.ok(rowButton(), "a Core is set up and there is no row"));
    cleanup();
    resetStageState();
    configured = false;
    await mount();
    await wait(50);
    assert.equal(rowButton() === null, true, "the row is drawn with no panel and no Core");
  });

  test("Customize's hide and reorder act on it like any other row", async () => {
    state.sidebar = { sections: DEFAULT_SIDEBAR.map((s) => ({ ...s, members: s.members.filter((m) => m !== "qsys") })), hidden: ["qsys"] };
    await mount();
    await wait(50);
    assert.equal(rowButton() === null, true, "a hidden Q-SYS row is drawn");
    cleanup();
    resetStageState();
    state.sidebar = {
      sections: DEFAULT_SIDEBAR.map((s) => ({ ...s, members: s.id === "top" ? ["home", "qsys"] : s.members.filter((m) => m !== "qsys") })),
      hidden: [],
    };
    const c = await mount();
    const rail = (c.querySelector(".bg-rail")?.textContent ?? "");
    assert.ok(rail.indexOf("Q-SYS") > 0 && rail.indexOf("Q-SYS") < rail.indexOf("Consoles"), "the row did not follow its saved place");
  });

  test("a Q-SYS panel is not among the sidebar's consoles", async () => {
    const c = await mount();
    const consoles = (c.querySelector(".bg-rail")?.textContent ?? "");
    assert.ok(consoles.includes("FOH"));
    assert.equal(consoles.includes("Zone 1"), false, "a panel is listed twice");
  });
});

describe("hovering the row", () => {
  test("hovering the row opens the flyout after 500 ms, not before", async () => {
    assert.equal(QSYS_FLYOUT_DELAY_MS, 500, "the approved delay is 500 ms");
    await mount();
    await hover();
    await wait(300);
    assert.equal(flyout() === null, true, "the flyout opened early");
    await eventually(() => assert.ok(flyout(), "the flyout never opened"), 1500);
    assert.deepEqual(labels(flyout()), ["Zone 1volunteer", "Boothstaff", "All panels and Q-SYS settings"]);
  });

  test("leaving before the delay is up opens nothing", async () => {
    await mount();
    await hover();
    await act(async () => void fireEvent.pointerOut(rowWrapper()!, { ...mouse, relatedTarget: document.body }));
    await wait(650);
    assert.equal(flyout() === null, true);
  });

  test("a touch does not start the hover: tapping opens the folder, never the flyout", async () => {
    await mount();
    await act(async () => void fireEvent.pointerOver(rowWrapper()!, { pointerType: "touch" }));
    await wait(650);
    assert.equal(flyout() === null, true, "a touch opened the flyout");
  });

  test("the flyout stays open while the pointer crosses into it, and closes when it leaves for elsewhere", async () => {
    await mount();
    await hover();
    await eventually(() => assert.ok(flyout()), 1500);
    // Row to flyout (the bridge is the flyout's own padding): not a leave.
    await act(async () => void fireEvent.pointerOut(rowWrapper()!, { ...mouse, relatedTarget: flyout()! }));
    await wait(50);
    assert.ok(flyout(), "crossing from the row into the flyout closed it");
    // Flyout to the page: a leave.
    await act(async () => void fireEvent.pointerOut(flyout()!, { ...mouse, relatedTarget: document.body }));
    await eventually(() => assert.equal(flyout() === null, true, "leaving did not close it"));
  });

  test("items highlight on hover; the current panel stays highlighted", async () => {
    await mount("/qsys/manage/booth");
    await hover();
    await eventually(() => assert.ok(flyout()), 1500);
    const [zone, booth, manage] = [...flyout()!.querySelectorAll<HTMLElement>("[role=menuitem]")];
    // The :hover paint itself is CSS, unreachable here; what is pinned is that every
    // item carries a hover style and that exactly the current one is marked and lit.
    for (const item of [zone, manage]) assert.match(item.className, /hover:bg-fill-active/, "no hover style");
    assert.equal(booth.getAttribute("aria-current"), "page");
    assert.match(booth.className, /bg-accent\/20/);
    // Names read in the foreground colour; only the last item is muted, as in the mockup.
    assert.match(zone.className, /(^|\s)text-fg(\s|$)/);
    assert.match(manage.className, /text-fg-muted/);
    assert.equal(zone.getAttribute("aria-current"), null);
    assert.equal(manage.getAttribute("aria-current"), null);
    assert.equal(zone.className.includes("bg-accent/20"), false, "a panel that is not current is lit");
  });

  test("on /qsys/manage the last item is the current one", async () => {
    await mount("/qsys/manage");
    await hover();
    await eventually(() => assert.ok(flyout()), 1500);
    const items = [...flyout()!.querySelectorAll<HTMLElement>("[role=menuitem]")];
    assert.deepEqual(items.map((i) => i.getAttribute("aria-current")), [null, null, "page"]);
  });

  test("choosing an item goes to that panel in the shell, and the last goes to /qsys/manage", async () => {
    await mount();
    await hover();
    await eventually(() => assert.ok(flyout()), 1500);
    await act(async () => void fireEvent.click(flyout()!.querySelectorAll<HTMLElement>("[role=menuitem]")[1]!));
    await eventually(() => assert.equal(where(), "/qsys/manage/booth"));
    assert.equal(flyout() === null, true, "the flyout stayed open after a choice");
    await hover();
    await eventually(() => assert.ok(flyout()), 1500);
    await act(async () => void fireEvent.click(flyout()!.querySelectorAll<HTMLElement>("[role=menuitem]")[2]!));
    await eventually(() => assert.equal(where(), "/qsys/manage"));
  });
});

describe("an open flyout goes away when the sidebar is left", () => {
  const open = async () => {
    await mount();
    await hover();
    await eventually(() => assert.ok(flyout()), 1500);
  };

  test("Escape closes it wherever focus is, including nowhere", async () => {
    await open();
    assert.equal(document.activeElement === document.body, true, "the test needs focus elsewhere");
    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
    assert.equal(flyout() === null, true, "Escape with focus elsewhere left it open");
  });

  test("scrolling the sidebar closes it", async () => {
    await open();
    await act(async () => void fireEvent.scroll(document.querySelector(".bg-rail")!));
    assert.equal(flyout() === null, true, "the flyout stayed put while the sidebar scrolled");
  });

  test("focus leaving the row and the flyout closes it; focus moving between them does not", async () => {
    await mount();
    rowButton()!.focus();
    await act(async () => void fireEvent.keyDown(rowButton()!, { key: "ArrowRight" }));
    await eventually(() => assert.ok(flyout()));
    const first = flyout()!.querySelector<HTMLElement>("[role=menuitem]")!;
    await eventually(() => assert.equal(document.activeElement === first, true));
    assert.ok(flyout(), "focus moving from the row into the flyout closed it");
    await act(async () => void fireEvent.blur(first, { relatedTarget: document.body }));
    assert.equal(flyout() === null, true, "a keyboard-opened flyout stayed after focus left");
  });
});

describe("the row's own menu", () => {
  test("a right-click closes a flyout that is open, and cancels one that is about to", async () => {
    await mount();
    await hover();
    await eventually(() => assert.ok(flyout()), 1500);
    await act(async () => void fireEvent.contextMenu(rowButton()!));
    assert.equal(flyout() === null, true, "the flyout stayed open under the row's menu");
    await hover();
    await wait(200);
    await act(async () => void fireEvent.contextMenu(rowButton()!));
    await wait(450);
    assert.equal(flyout() === null, true, "a flyout opened over the row's menu");
  });
});

describe("tapping the row", () => {
  test("tapping the row expands it in place; tapping again collapses", async () => {
    await mount();
    assert.equal(folder() === null, true);
    await act(async () => void fireEvent.click(rowButton()!));
    assert.ok(folder(), "the row did not expand");
    assert.equal(rowButton()!.getAttribute("aria-expanded"), "true");
    // The folder lists every panel and, last, the way to /qsys/manage: touch has no flyout.
    assert.deepEqual(labels(folder()), ["Zone 1", "Booth", "All panels and Q-SYS settings"]);
    assert.equal(where(), "/", "tapping the row navigated");
    await act(async () => void fireEvent.click(rowButton()!));
    assert.equal(folder() === null, true, "the row did not collapse");
    assert.equal(rowButton()!.getAttribute("aria-expanded"), "false");
  });

  test("in the mobile drawer, tapping the row opens the folder and leaves the drawer open; choosing an item closes it", async () => {
    let closed = 0;
    await mount("/", () => void closed++);
    await act(async () => void fireEvent.click(rowButton()!));
    assert.ok(folder(), "the row did not expand");
    assert.equal(closed, 0, "tapping the row closed the drawer");
    await act(async () => void fireEvent.click([...folder()!.querySelectorAll("button")][0]!));
    await eventually(() => assert.equal(where(), "/qsys/manage/zone-1"));
    assert.equal(closed, 1, "choosing a panel left the drawer open");
  });

  test("an item in the folder navigates", async () => {
    await mount("/qsys/manage/zone-1");
    await act(async () => void fireEvent.click(rowButton()!));
    assert.equal(folder()!.querySelector("[aria-current=page]")?.textContent, "Zone 1");
    await act(async () => void fireEvent.click([...folder()!.querySelectorAll("button")][1]!));
    await eventually(() => assert.equal(where(), "/qsys/manage/booth"));
  });

  test("the row is lit while the page is under /qsys/manage, and only then", async () => {
    await mount("/qsys/manage/booth");
    assert.match(rowButton()!.className, /bg-accent\/12/);
    cleanup();
    resetStageState();
    await mount("/");
    assert.equal(/bg-accent\/12/.test(rowButton()!.className), false);
  });
});

describe("the keyboard", () => {
  test("ArrowRight on the row opens the flyout and moves into it; arrows move; Escape closes and returns to the row", async () => {
    await mount();
    rowButton()!.focus();
    await act(async () => void fireEvent.keyDown(rowButton()!, { key: "ArrowRight" }));
    await eventually(() => assert.ok(flyout(), "the flyout did not open"));
    const items = () => [...flyout()!.querySelectorAll<HTMLElement>("[role=menuitem]")];
    await eventually(() => assert.equal(document.activeElement === items()[0], true, "focus did not move into the flyout"));
    await act(async () => void fireEvent.keyDown(items()[0]!, { key: "ArrowDown" }));
    assert.equal(document.activeElement === items()[1], true);
    await act(async () => void fireEvent.keyDown(items()[1]!, { key: "ArrowDown" }));
    assert.equal(document.activeElement === items()[2], true);
    await act(async () => void fireEvent.keyDown(items()[2]!, { key: "ArrowDown" }));
    assert.equal(document.activeElement === items()[0], true, "ArrowDown did not wrap");
    await act(async () => void fireEvent.keyDown(items()[0]!, { key: "ArrowUp" }));
    assert.equal(document.activeElement === items()[2], true, "ArrowUp did not wrap");
    await act(async () => void fireEvent.keyDown(items()[2]!, { key: "Escape" }));
    assert.equal(flyout() === null, true, "Escape did not close it");
    assert.equal(document.activeElement === rowButton(), true, "focus did not return to the row");
  });

  test("Escape on the row closes a flyout opened by hover", async () => {
    await mount();
    await hover();
    await eventually(() => assert.ok(flyout()), 1500);
    rowButton()!.focus();
    await act(async () => void fireEvent.keyDown(rowButton()!, { key: "Escape" }));
    assert.equal(flyout() === null, true);
  });
});
