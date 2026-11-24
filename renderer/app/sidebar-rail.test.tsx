// The real rail under the real Customize provider, fed the way the server feeds
// it: a hydrate, broadcasts on the SSE channel, and saves that answer or refuse.
//
// These are the behaviours that live in the provider's state rather than in the
// resolver: drawing the saved arrangement, putting it back after a refusal, a
// pending change surviving a broadcast about something else, taking in another
// browser's change, an Undo that cannot revert a later change, and which menu a
// right-click or a long-press opens.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installDom, unmountAndTeardown } from "../test-dom.js";

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

const VIEWS = [
  { id: "view-foh", name: "FOH", kind: "custom", surface: "console", ndiSource: null, createdAt: "" },
];

type Sidebar = { sections: { id: string; label: string; kind: string; members: string[] }[]; hidden: string[] };
let state: { views: unknown[]; outputs: unknown[]; appName: string; sidebar: Sidebar };
/** What a POST /api/sidebar does: take it, refuse it, or wait to be told. */
let mode: "ok" | "refuse" | "hold" | "late" = "ok";
let release: (() => void) | null = null;
const saves: Sidebar[] = [];
let consoleHides = 0;
/** While set, the next save waits here before the server answers it: a slow link. */
let hold: Promise<void> | null = null;
let releaseHold: (() => void) | null = null;
function holdNextSave(): void {
  hold = new Promise<void>((r) => (releaseHold = r));
}

function emitState(): void {
  const frame = { data: JSON.stringify(state) };
  for (const h of [...(listeners.get("stage:state-changed") ?? [])]) h(frame);
}

const json = (status: number, value: unknown) => ({
  ok: status < 400,
  status,
  json: async () => value,
  text: async () => JSON.stringify(value),
});

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
  const path = String(input);
  const method = init?.method ?? "GET";
  if (method === "GET" && path.startsWith("/api/state")) return json(200, state);
  if (method === "PATCH" && path.startsWith("/api/views/")) {
    consoleHides += 1;
    if (hold) {
      const waiting = hold;
      hold = null;
      await waiting;
    }
    return json(200, state);
  }
  if (method === "POST" && path === "/api/sidebar") {
    const body = JSON.parse(init?.body ?? "{}") as Sidebar;
    saves.push(body);
    if (hold) {
      const waiting = hold;
      hold = null; // only this one waits
      await waiting;
    }
    if (mode === "refuse") return json(400, { error: "refused for the test" });
    if (mode === "hold") await new Promise<void>((r) => (release = r));
    // "late": answered, but the broadcast of it has not arrived yet.
    if (mode === "late") return json(200, { ...state, sidebar: body });
    state = { ...state, sidebar: body };
    emitState();
    return json(200, state);
  }
  return json(200, {});
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Rail } = await import("./rail.js");
const { CustomizeProvider, useCustomize } = await import("./customize-mode.js");
const { Toaster, TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { DEFAULT_SIDEBAR } = await import("@main/services/sidebar-arrangement");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  state = { views: VIEWS, outputs: [], appName: "Rail test app", sidebar: { sections: [], hidden: [] } };
  mode = "ok";
  release = null;
  hold = null;
  releaseHold = null;
  saves.length = 0;
  consoleHides = 0;
});
afterEach(() => {
  // A save a failed test left waiting must not keep the run open.
  releaseHold?.();
  cleanup();
  resetStageState();
  resetReplayCache();
  listeners.clear();
});

/** The arrangement with Patch moved up beside Home. */
function patchBesideHome(): Sidebar {
  return {
    sections: DEFAULT_SIDEBAR.map((s) => ({
      ...s,
      members: s.id === "top" ? ["home", "patch"] : s.members.filter((m) => m !== "patch"),
    })),
    hidden: [],
  };
}

let api: ReturnType<typeof useCustomize> | null = null;
/** Hands the test the provider's own actions, from an effect, as a page would use them. */
function Probe() {
  const customize = useCustomize();
  React.useEffect(() => {
    api = customize;
  });
  return null;
}

async function mount(): Promise<HTMLElement> {
  const root = createRootRoute({
    component: () =>
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(
            CustomizeProvider,
            null,
            React.createElement(Probe),
            React.createElement(Rail, { onToggleCollapsed() {}, dragging: false, onStartResize() {}, onResetWidth() {} }),
          ),
          React.createElement(Toaster),
        ),
      ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const { container } = render(React.createElement(RouterProvider, { router }));
  await eventually(() => assert.ok(text(container).includes("Rail test app"), "the rail never read the state"));
  return container;
}

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Where a label sits in the rail's text, or -1. The rail only: a toast that
 *  names the page is not the page. */
const at = (c: HTMLElement, label: string) => text(c.querySelector(".bg-rail")).indexOf(label);

describe("the rail and its saved arrangement", () => {
  test("draws the saved arrangement, not the default", async () => {
    state.sidebar = patchBesideHome();
    const c = await mount();
    assert.ok(at(c, "Patch") > 0 && at(c, "Patch") < at(c, "Consoles"), `Patch is not up beside Home: ${text(c).slice(0, 120)}`);
  });

  test("a refused save puts the saved arrangement back", async () => {
    const c = await mount();
    mode = "refuse";
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    await eventually(() => assert.ok(at(c, "Patch") >= 0, "the rail still shows a hide the server refused"));
  });

  test("a pending hide is not undone by a broadcast about something else", async () => {
    const c = await mount();
    mode = "hold";
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(at(c, "Patch"), -1));
    // Another change somewhere: a new state object, the same arrangement.
    await act(async () => {
      state = { ...state, appName: "Rail test app" };
      emitState();
    });
    assert.equal(at(c, "Patch"), -1, "the hide flickered back on an unrelated broadcast");
    await act(async () => release?.());
    await eventually(() => assert.equal(at(c, "Patch"), -1));
  });

  test("a saved hide whose broadcast is late is not undone by a broadcast about something else", async () => {
    const c = await mount();
    mode = "late";
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    // Answered; the echo is still on its way, and something else broadcasts first.
    await act(async () => {
      state = { ...state, appName: "Rail test app" };
      emitState();
    });
    assert.equal(at(c, "Patch"), -1, "the hide flickered back on an unrelated broadcast");
    await act(async () => {
      state = { ...state, sidebar: saves[0] };
      emitState();
    });
    assert.equal(at(c, "Patch"), -1);
  });

  test("in the mode, another browser's change is taken in and kept by the next save", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    // Another browser hides Baptisms.
    await act(async () => {
      state = { ...state, sidebar: { sections: [], hidden: ["baptisms"] } };
      emitState();
    });
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    assert.deepEqual([...saves[0].hidden].sort(), ["baptisms", "patch"], "this browser's save undid the other's hide");
  });

  test("a newer change retires the older Undo, so Undo puts back only the latest change", async () => {
    await mount();
    await act(async () => api!.hide("baptisms", "Baptisms"));
    await eventually(() => assert.equal(saves.length, 1));
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 2));
    // The toast store outlives a test, so earlier tests' toasts may be up too:
    // what matters is that the older change's Undo is gone.
    const offered = screen.getAllByRole("button", { name: "Undo" }).map((u) => text(u.parentElement));
    assert.ok(!offered.some((t) => t.includes("Hid Baptisms")), `the older change's Undo is still on screen: ${offered.join(" / ")}`);
    const undos = screen.getAllByRole("button", { name: "Undo" });
    await act(async () => fireEvent.click(undos[undos.length - 1]));
    await eventually(() => assert.equal(saves.length, 3));
    assert.deepEqual(saves[2].hidden, ["baptisms"]);
  });
});

describe("saves that are still out", () => {
  test("in the mode, another browser's change that lands while a save is out is taken in once it settles", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    mode = "late"; // answered with this save's own arrangement, no echo
    holdNextSave();
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    // The other browser saved after this one; its broadcast gets here before this answer does.
    await act(async () => {
      state = { ...state, sidebar: { sections: [], hidden: ["baptisms"] } };
      emitState();
    });
    await act(async () => releaseHold!());
    // The mode's rail is not `.bg-rail`, so read what it draws from the provider.
    await eventually(() => assert.deepEqual(api!.resolved.hiddenPages, ["baptisms"], "the other browser's hide was dropped, or this browser's kept"));
  });

  test("the Hid toast and its Undo wait for the save, and never appear for one the server refused", async () => {
    await mount();
    holdNextSave();
    await act(async () => api!.hide("patch", "Patch held"));
    await eventually(() => assert.equal(saves.length, 1));
    assert.equal(screen.queryAllByText(/Hid Patch held/).length, 0, "Hid toast shown before the save answered");
    await act(async () => releaseHold!());
    await eventually(() => assert.ok(screen.queryAllByText(/Hid Patch held/).length > 0));

    mode = "refuse";
    await act(async () => api!.hide("baptisms", "Baptisms refused"));
    await eventually(() => assert.equal(saves.length, 2));
    await eventually(() => assert.ok(screen.queryAllByText("refused for the test").length > 0));
    assert.equal(screen.queryAllByText(/Hid Baptisms refused/).length, 0, "Hid toast shown beside the refusal");
  });

  test("a console's Hid toast waits for its own save too", async () => {
    await mount();
    holdNextSave();
    await act(async () => api!.hide("console:view-foh", "FOH held"));
    await eventually(() => assert.equal(consoleHides, 1));
    assert.equal(screen.queryAllByText(/Hid FOH held/).length, 0, "Hid toast shown before the save answered");
    await act(async () => releaseHold!());
    await eventually(() => assert.ok(screen.queryAllByText(/Hid FOH held/).length > 0));
  });
});

describe("leaving the mode", () => {
  test("Escape leaves it, as Done does", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    await eventually(() => assert.equal(api!.customizing, true));
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await eventually(() => assert.equal(api!.customizing, false, "Escape did not leave Customize mode"));
  });

  test("Escape in the name field cancels that edit and keeps the mode", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    const name = await eventually(() => screen.getByLabelText("App name"));
    await act(async () => fireEvent.change(name, { target: { value: "Something else" } }));
    await act(async () => fireEvent.keyDown(name, { key: "Escape" }));
    assert.equal(api!.customizing, true, "Escape in a field left the mode");
    assert.equal((name as HTMLInputElement).value, "Rail test app");
  });
});

describe("which menu opens", () => {
  test("a right-click on a row opens the row's menu and not the rail's as well", async () => {
    await mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Patch" }));
    const menus = await eventually(() => {
      const m = screen.getAllByRole("menu");
      assert.ok(m.length > 0);
      return m;
    });
    assert.equal(menus.length, 1, `${menus.length} menus opened`);
    assert.match(text(menus[0]), /Hide “Patch”/);
  });

  /** A touch held past the long-press delay on `target`, then lifted. */
  async function longPress(target: Element, pointerId: number): Promise<void> {
    fireEvent.pointerDown(target, { pointerId, pointerType: "touch", clientX: 10, clientY: 10 });
    await act(async () => new Promise((r) => setTimeout(r, 700)));
    fireEvent.pointerUp(target, { pointerId, pointerType: "touch", clientX: 10, clientY: 10 });
  }
  const menuTexts = () => screen.queryAllByRole("menu").map((m) => text(m));

  test("a long-press on a console's glyph opens its icon menu and nothing else", async () => {
    await mount();
    const glyph = document.querySelector<HTMLElement>("[data-rail-glyph]");
    assert.ok(glyph, "no console glyph in the rail");
    await longPress(glyph.firstElementChild ?? glyph, 1);
    assert.equal(screen.queryByText("Hide “FOH”"), null, "the row's menu opened over the glyph's");
    // The glyph's own menu is the icon picker, a dialog. The rail's menu (Customize)
    // opening beside it is the second menu the press must not open.
    assert.deepEqual(menuTexts(), [], "a menu opened beside the icon picker");
    assert.deepEqual(screen.queryAllByRole("dialog").map((d) => d.getAttribute("aria-label")), ["FOH icon"]);
  });

  test("a long-press on a page row's icon opens the row's menu once", async () => {
    await mount();
    const icon = screen.getByRole("button", { name: "Patch" }).querySelector("svg");
    assert.ok(icon, "no icon in the Patch row");
    await longPress(icon, 2);
    const menus = menuTexts();
    assert.equal(menus.length, 1, `${menus.length} menus opened: ${JSON.stringify(menus)}`);
    assert.match(menus[0], /Hide “Patch”/);
  });

  test("a long-press on a page row's label opens the row's menu once", async () => {
    await mount();
    const label = [...screen.getByRole("button", { name: "Patch" }).querySelectorAll("span")].find((s) => s.textContent === "Patch");
    assert.ok(label, "no label in the Patch row");
    await longPress(label, 3);
    const menus = menuTexts();
    assert.equal(menus.length, 1, `${menus.length} menus opened: ${JSON.stringify(menus)}`);
    assert.match(menus[0], /Hide “Patch”/);
  });

  test("a long-press on the resize handle opens Reset sidebar width once", async () => {
    await mount();
    await longPress(screen.getByRole("separator", { name: "Resize sidebar" }), 4);
    const menus = menuTexts();
    assert.equal(menus.length, 1, `${menus.length} menus opened: ${JSON.stringify(menus)}`);
    assert.match(menus[0], /Reset sidebar width/);
  });

  test("a long-press on the rail's own space still opens the rail's menu", async () => {
    await mount();
    const rail = document.querySelector(".bg-rail");
    assert.ok(rail, "no rail");
    await longPress(rail, 5);
    const menus = menuTexts();
    assert.equal(menus.length, 1, `${menus.length} menus opened: ${JSON.stringify(menus)}`);
    assert.match(menus[0], /Customize sidebar/);
  });
});
