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
type Revisions = { boot: string; sidebar: number; bar: number };
let state: { views: unknown[]; outputs: unknown[]; appName: string; sidebar: Sidebar; listRevisions: Revisions };
/** What a POST /api/sidebar does: take it, refuse it (or only this one), or wait to be told. */
let mode: "ok" | "refuse" | "refuse-once" | "hold" | "late" = "ok";
let release: (() => void) | null = null;
const saves: Sidebar[] = [];
let consoleHides = 0;
/** While set, the next save waits here: a slow link. */
let hold: Promise<void> | null = null;
let releaseHold: (() => void) | null = null;
/** Where it waits: before the server saves it ("request"), or after, before the answer gets back ("answer"). */
let holdAt: "request" | "answer" = "request";
function holdNextSave(at: "request" | "answer" = "request"): void {
  holdAt = at;
  hold = new Promise<void>((r) => (releaseHold = r));
}

/**
 * The server saving an arrangement: the one place its count of saves goes up, as
 * setSidebar does. Every save, ours or another browser's, goes through here, so
 * no test can hand out an order the server could not.
 */
function serverSaves(sidebar: Sidebar): typeof state {
  state = { ...state, sidebar, listRevisions: { ...state.listRevisions, sidebar: state.listRevisions.sidebar + 1 } };
  return state;
}
/** Another browser's save, and its broadcast. */
function otherBrowserSaves(sidebar: Sidebar): void {
  serverSaves(sidebar);
  emitState();
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
    const waiting = hold;
    hold = null; // only this one waits
    if (waiting && holdAt === "request") await waiting;
    if (mode === "refuse" || mode === "refuse-once") {
      if (mode === "refuse-once") mode = "ok";
      if (waiting && holdAt === "answer") await waiting;
      return json(400, { error: "refused for the test" });
    }
    if (mode === "hold") await new Promise<void>((r) => (release = r));
    const answered = serverSaves(body);
    // "late": saved and answered, but the broadcast of it has not arrived yet.
    if (mode !== "late") emitState();
    if (waiting && holdAt === "answer") await waiting;
    return json(200, answered);
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
  state = {
    views: VIEWS,
    outputs: [],
    appName: "Rail test app",
    sidebar: { sections: [], hidden: [] },
    listRevisions: { boot: "boot-1", sidebar: 0, bar: 0 },
  };
  mode = "ok";
  release = null;
  hold = null;
  holdAt = "request";
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
    // The echo: the server already holds this save.
    await act(async () => emitState());
    assert.equal(at(c, "Patch"), -1);
  });

  test("in the mode, another browser's change is taken in and kept by the next save", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    // Another browser hides Baptisms.
    await act(async () => otherBrowserSaves({ sections: [], hidden: ["baptisms"] }));
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
    holdNextSave("answer"); // saved at once; the answer is what is slow
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    // The other browser saved after this one; its broadcast gets here before this answer does.
    await act(async () => otherBrowserSaves({ sections: [], hidden: ["baptisms"] }));
    await act(async () => releaseHold!());
    // The mode's rail is not `.bg-rail`, so read what it draws from the provider.
    await eventually(() => assert.deepEqual(api!.resolved.hiddenPages, ["baptisms"], "the other browser's hide was dropped, or this browser's kept"));
  });

  test("a new section is the same section while its save is out and once it has saved", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    holdNextSave();
    let added: Promise<string | null> = Promise.resolve(null);
    await act(async () => {
      added = api!.addSection();
    });
    await eventually(() => assert.equal(saves.length, 1));
    const id = saves[0].sections.at(-1)!.id;
    // Drawn while the save is out: the id the save carries, not another one made on a redraw.
    assert.ok(api!.resolved.sections.some((s) => s.id === id), "the drawn section is not the one that was asked for");
    assert.ok(saves[0].sections.some((s) => s.id === id), "the saved section is not the one that was drawn");
    await act(async () => releaseHold!());
    assert.equal(await added, id, "addSection did not answer with the section it added");
    await eventually(() => assert.ok(api!.resolved.sections.some((s) => s.id === id)));
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

describe("whose save is newer", () => {
  // The server counts its saves (StageState.listRevisions), and the answer to a save
  // and its broadcast carry the same count. These are the orders that cannot be told
  // apart by what the arrangement says.

  test("another browser's save that landed before ours, broadcast while ours was out, is not drawn over ours", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    mode = "late"; // our echo has not arrived when the answer does
    holdNextSave(); // the request is slow: the server has not saved ours yet
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    // Another browser's save lands first, and its broadcast arrives while ours is out.
    await act(async () => otherBrowserSaves({ sections: [], hidden: ["baptisms"] }));
    // Ours lands after it, built on what it was clicked on: the server holds ours.
    await act(async () => releaseHold!());
    await eventually(() => assert.deepEqual(state.sidebar.hidden, ["patch"]));
    await eventually(() =>
      assert.deepEqual(api!.resolved.hiddenPages, ["patch"], "the older broadcast was drawn over the answer to our newer save"),
    );
    // A change made now builds on what the server holds, and does not undo our Hide.
    mode = "ok";
    await act(async () => api!.hide("history", "History"));
    await eventually(() => assert.equal(saves.length, 2));
    assert.deepEqual([...saves[1].hidden].sort(), ["history", "patch"], "the next save undid our Hide Patch");
  });

  test("another browser putting the arrangement back while our save is out is taken in", async () => {
    const before = state.sidebar;
    await mount();
    holdNextSave("answer"); // saved and broadcast at once; the answer is slow
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    // Another browser puts it straight back: the same arrangement we last had.
    await act(async () => otherBrowserSaves(before));
    await act(async () => releaseHold!());
    await eventually(() => assert.deepEqual(api!.resolved.hiddenPages, [], "the other browser's change was dropped"));
    assert.equal(api!.draft, null, "a draft is still held over what the server holds");
    assert.ok(at(document.body as HTMLElement, "Patch") >= 0, "the rail still hides Patch");
  });

  test("a restarted server's changes are taken in, though its count starts again", async () => {
    await mount();
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    await eventually(() => assert.deepEqual(api!.resolved.hiddenPages, ["patch"]));
    // The server restarts (or a backup is restored): a new boot, counting from 0
    // again, below the answer this browser holds.
    state = { ...state, listRevisions: { boot: "boot-2", sidebar: 0, bar: 0 } };
    await act(async () => otherBrowserSaves({ sections: [], hidden: ["baptisms"] }));
    await eventually(() =>
      assert.deepEqual(api!.resolved.hiddenPages, ["baptisms"], "a change on the restarted server was taken for an old echo"),
    );
  });

  describe("a server that restarts before the stream reconnects", () => {
    // The page still holds the old run's last broadcast; the new run answers saves.
    // The new run is newer than the old, but never the other way round.
    async function restartWithStreamDown(): Promise<void> {
      await mount();
      await act(async () => api!.open("sidebar"));
      state = { ...state, listRevisions: { boot: "boot-2", sidebar: 0, bar: 0 } };
      mode = "late"; // no broadcast reaches the page: the stream is down
    }
    const settle = () => act(async () => new Promise((r) => setTimeout(r, 50)));

    test("a save answered by the new run is not drawn back by the old run's state", async () => {
      await restartWithStreamDown();
      await act(async () => api!.hide("patch", "Patch"));
      await eventually(() => assert.equal(saves.length, 1));
      await settle();
      assert.deepEqual(api!.resolved.hiddenPages, ["patch"], "the old run's state was drawn over the new run's answer");
    });

    test("the next change builds on that save, not on the old run's state", async () => {
      await restartWithStreamDown();
      await act(async () => api!.hide("patch", "Patch"));
      await eventually(() => assert.equal(saves.length, 1));
      await settle();
      await act(async () => api!.hide("history", "History"));
      await eventually(() => assert.equal(saves.length, 2));
      assert.deepEqual([...saves[1].hidden].sort(), ["history", "patch"], "the second save dropped the first");
    });

    test("a refused save reads back the new run's arrangement and keeps it", async () => {
      await restartWithStreamDown();
      serverSaves({ sections: [], hidden: ["baptisms"] }); // the new run holds this; nobody has heard
      mode = "refuse";
      await act(async () => api!.hide("patch", "Patch"));
      await eventually(() => assert.equal(saves.length, 1));
      await settle();
      assert.deepEqual(api!.resolved.hiddenPages, ["baptisms"], "the read-back was drawn over by the old run's state");
    });
  });
});

describe("what a change lands on", () => {
  // A change is applied when its turn to save comes, to what the server holds then,
  // which is not what was drawn when it was clicked if an earlier change was refused.
  // What it says, what its Undo puts back, and what it builds on follow the former.

  test("an Undo puts back what the change was applied to, not an earlier change the server refused", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    holdNextSave();
    mode = "refuse-once";
    await act(async () => api!.hide("patch", "Patch"));
    await eventually(() => assert.equal(saves.length, 1));
    // Clicked while Hide Patch is still drawn; the server refuses Patch and saves this.
    await act(async () => api!.hide("baptisms", "Baptisms"));
    await act(async () => releaseHold!());
    await eventually(() => assert.equal(saves.length, 2));
    await eventually(() => assert.deepEqual(state.sidebar.hidden, ["baptisms"]));
    const undo = await eventually(() => {
      const u = screen.getAllByRole("button", { name: "Undo" }).filter((b) => text(b.parentElement).includes("Hid Baptisms"));
      assert.ok(u.length > 0, "no Undo for Hid Baptisms");
      return u[u.length - 1];
    });
    await act(async () => fireEvent.click(undo));
    await eventually(() => assert.equal(saves.length, 3));
    assert.deepEqual(saves[2].hidden, [], "Undo of Hid Baptisms put back a Hide the server had refused");
  });

  test("a change that an earlier refusal left nothing to do says nothing and offers no Undo", async () => {
    const { removeSection } = await import("./sidebar-edits.js");
    await mount();
    await act(async () => api!.open("sidebar"));
    mode = "refuse";
    holdNextSave();
    await act(async () => {
      void api!.addSection();
    });
    await eventually(() => assert.equal(saves.length, 1));
    const id = saves[0].sections.at(-1)!.id;
    // Removed while the add is still out; the add is then refused, so there is nothing to remove.
    let removed: Promise<unknown> = Promise.resolve();
    await act(async () => {
      removed = Promise.resolve(api!.apply((r) => removeSection(r, id), "Removed the new section.", true));
    });
    await act(async () => {
      releaseHold!();
      await removed;
    });
    await eventually(() => assert.ok(screen.queryAllByText("refused for the test").length > 0));
    assert.equal(saves.length, 1, "the no-op was saved");
    assert.equal(screen.queryAllByText("Removed the new section.").length, 0, "a change that changed nothing was announced");
  });

  test("a new section the server refuses gives no id to name", async () => {
    await mount();
    await act(async () => api!.open("sidebar"));
    mode = "refuse";
    let added: Promise<string | null> = Promise.resolve("never asked");
    await act(async () => {
      added = api!.addSection();
    });
    assert.equal(await added, null, "a refused section was handed back to be renamed");
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

  test("a right-click on a console's glyph opens its icon menu and not the row's", async () => {
    await mount();
    const glyph = document.querySelector<HTMLElement>("[data-rail-glyph]");
    assert.ok(glyph, "no console glyph in the rail");
    fireEvent.contextMenu(glyph.firstElementChild ?? glyph);
    await eventually(() => assert.ok(screen.queryAllByRole("dialog").length > 0, "the icon picker never opened"));
    assert.deepEqual(screen.queryAllByRole("menu").map((m) => text(m)), [], "a menu opened beside the icon picker");
  });

  /** A touch held past the long-press delay on `target`, then lifted. */
  async function longPress(target: Element, pointerId: number): Promise<void> {
    fireEvent.pointerDown(target, { pointerId, pointerType: "touch", clientX: 10, clientY: 10 });
    await act(async () => new Promise((r) => setTimeout(r, 700)));
    fireEvent.pointerUp(target, { pointerId, pointerType: "touch", clientX: 10, clientY: 10 });
  }
  const menuTexts = () => screen.queryAllByRole("menu").map((m) => text(m));

  // A failed assertion prints the values it compared, and a jsdom element prints the
  // whole page: an element compared with null took over a minute to fail. So these
  // compare what an element says, never the element. The timeout is for the rest.
  test("a long-press on a console's glyph opens its icon menu and nothing else", { timeout: 15_000 }, async () => {
    await mount();
    const glyph = document.querySelector<HTMLElement>("[data-rail-glyph]");
    assert.ok(glyph, "no console glyph in the rail");
    const target = glyph.firstElementChild ?? glyph;
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    // Held until the glyph's own menu, the icon picker, has opened.
    await eventually(() => assert.ok(screen.queryAllByRole("dialog").length > 0, "the icon picker never opened"));
    fireEvent.pointerUp(target, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    assert.equal(screen.queryByText("Hide “FOH”") !== null, false, "the row's menu opened over the glyph's");
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

  test("a tap on a row still closes an open popover", async () => {
    // A popover (a non-modal Radix one, as Customize's own menus and pickers are)
    // closes on a press outside it, which it hears on `document`. A trigger that
    // stopped a touch's press from getting there left it open.
    const { Popover } = await import("radix-ui");
    let closed = false;
    await mount();
    render(
      React.createElement(
        Popover.Root,
        { open: true, modal: false, onOpenChange: (open: boolean) => (closed ||= !open) },
        React.createElement(Popover.Anchor, null, React.createElement("span", null, "anchor")),
        React.createElement(Popover.Portal, null, React.createElement(Popover.Content, null, "Popover body")),
      ),
    );
    await eventually(() => assert.ok(screen.getByText("Popover body")));
    // Radix starts listening for a press outside on the tick after it opens.
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    const row = screen.getByRole("button", { name: "Patch" });
    fireEvent.pointerDown(row, { pointerId: 7, pointerType: "touch", clientX: 1, clientY: 1 });
    fireEvent.pointerUp(row, { pointerId: 7, pointerType: "touch", clientX: 1, clientY: 1 });
    fireEvent.click(row);
    await eventually(() => assert.ok(closed, "a tap on a rail row left the popover open"));
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
