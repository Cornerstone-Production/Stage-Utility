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
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  if (method === "POST" && path === "/api/sidebar") {
    const body = JSON.parse(init?.body ?? "{}") as Sidebar;
    saves.push(body);
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
  saves.length = 0;
});
afterEach(() => {
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
    await act(async () => api!.open());
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

  test("a long-press on a console's glyph opens its icon menu and not the row's", async () => {
    await mount();
    const glyph = document.querySelector<HTMLElement>("[data-rail-glyph]");
    assert.ok(glyph, "no console glyph in the rail");
    const target = glyph.firstElementChild ?? glyph;
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    await act(async () => new Promise((r) => setTimeout(r, 700)));
    fireEvent.pointerUp(target, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    assert.equal(screen.queryByText("Hide “FOH”"), null, "the row's menu opened over the glyph's");
  });
});
