// A console can be kept out of the sidebar and still be a page.
//
// `showInSidebar` is about the LIST, and one helper once answered two questions:
// "which consoles does the rail list" and "which URLs are console pages". Making
// it answer only the first would have meant a hidden console opened at
// /consoles/<id> with no title, the shell's gutter, and its chrome flag ignored —
// so the two are asserted separately here:
//
//   sidebarConsoleList    the rail's list: shown consoles only
//   consoleViewList       every console: pages, titles, full-bleed, chrome
//
// Both halves are run, and so is the real Rail against a hidden console, because
// a helper that filters correctly proves nothing if the rail reads the other one.
//
// NOT asserted here: that the row leaves the rail without a reload when the flag
// flips — that is the live state store feeding the rail, driven in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import type { View } from "../../main/types/views.js";

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
// The rail's theme hook reads the OS colour scheme; jsdom has no matchMedia.
(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});

const {
  consoleHidesChrome, consolePages, consoleViewList, isConsolePath, isFullBleedPath, resolvePage, sidebarConsoleList,
} = await import("./active-page.js");
const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Rail } = await import("./rail.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});
after(() => unmountAndTeardown(cleanup, teardown));

/** Invented, as everything in this repo's fixtures is. */
const SHOWN = { id: "view-booth", name: "Booth", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z" };
const HIDDEN = {
  id: "view-stage-left", name: "Stage left controls", kind: "custom", surface: "console", showInSidebar: false, hideChrome: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const EXPLICIT = { id: "view-monitor", name: "Monitor World", kind: "custom", surface: "console", showInSidebar: true, createdAt: "2026-01-01T00:00:00.000Z" };
const WALL = { id: "view-lobby", name: "Lobby", kind: "slots", surface: "display", showInSidebar: false, createdAt: "2026-01-01T00:00:00.000Z" };
const HOME = { id: "home", name: "Home", kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z" };
const VIEWS = [HOME, SHOWN, HIDDEN, EXPLICIT, WALL] as unknown as View[];

const ids = (vs: View[]) => vs.map((v) => v.id);

describe("which consoles the sidebar lists", () => {
  test("a console with the field absent is listed, so every existing console stays", () => {
    assert.ok(ids(sidebarConsoleList(VIEWS)).includes("view-booth"), "an existing console fell out of the sidebar");
  });

  test("an explicit true is listed, and false is not", () => {
    assert.deepEqual(ids(sidebarConsoleList(VIEWS)), ["view-booth", "view-monitor"]);
  });

  test("turning it back on lists it again", () => {
    const back = VIEWS.map((v) => (v.id === HIDDEN.id ? { ...v, showInSidebar: true } : v));
    assert.ok(ids(sidebarConsoleList(back)).includes(HIDDEN.id));
  });

  test("a display View is never listed, whatever its flag says", () => {
    assert.ok(!ids(sidebarConsoleList(VIEWS)).includes(WALL.id));
  });
});

describe("a hidden console is still a page", () => {
  test("it stays in the full console list", () => {
    assert.deepEqual(ids(consoleViewList(VIEWS)), ["view-booth", "view-stage-left", "view-monitor"]);
  });

  test("its URL resolves and the shell titles it with its name", () => {
    const active = resolvePage(`/consoles/${HIDDEN.id}`, consolePages(VIEWS));
    assert.equal(active?.page.label, "Stage left controls", "a hidden console opens with no title");
    assert.equal(active?.exact, true);
  });

  test("the shell still knows it is a console: full-bleed, and its own chrome setting", () => {
    assert.equal(isConsolePath(`/consoles/${HIDDEN.id}`, VIEWS), true);
    assert.equal(isFullBleedPath(`/consoles/${HIDDEN.id}`, VIEWS), true);
    assert.equal(consoleHidesChrome(`/consoles/${HIDDEN.id}`, VIEWS), true, "a hidden console lost its chrome setting");
  });

  test("an unknown console id still resolves to nothing", () => {
    assert.equal(resolvePage("/consoles/view-nope", consolePages(VIEWS)), null);
  });
});

describe("the real rail", () => {
  const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

  async function renderRailAt(views: unknown[], url: string): Promise<HTMLElement> {
    const f = stubFetchWithLog((u) => {
      if (u.includes("/api/state")) return ok({ views, outputs: [], appName: "Stage Utility" });
      return ok({});
    });
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
    await settle();
    await settle();
    f.restore();
    return container;
  }

  test("lists a shown console and leaves a hidden one out", async () => {
    const c = await renderRailAt(VIEWS, "/");
    const rail = text(c);
    assert.ok(rail.includes("Consoles"), `the Consoles group is missing: ${rail.slice(0, 200)}`);
    assert.ok(rail.includes("Booth"), "a console with the field absent is not in the rail");
    assert.ok(rail.includes("Monitor World"), "a console with the field true is not in the rail");
    assert.ok(!rail.includes("Stage left controls"), "a hidden console is in the rail");
  });

  test("the Consoles group goes away when every console is hidden", async () => {
    const c = await renderRailAt([HIDDEN], "/");
    assert.ok(!text(c).includes("Consoles"), "an empty Consoles group is drawn");
  });
});
