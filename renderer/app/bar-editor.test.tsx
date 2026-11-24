// The context bar's editor, in place: the real ContextBar and the real tray under
// the real Customize provider, fed the way the server feeds them.
//
// What jsdom cannot see is the drag itself (every rect is zero) and the 320 px
// measurement (nothing is laid out); the drag geometry is bar-drop.test.ts, and
// the measured warning was driven in a browser. These hold the state: a refusal
// puts the strip back, the phone follows the desktop bar until edited, the
// default set comes with an Undo, and the mode outlives a change of tab.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installDom, mountInAct, unmountAndTeardown } from "../test-dom.js";

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


type Bar = { barItems: string[]; barMobileItems: string[] };
let state: Record<string, unknown> & Bar;
let refuse = false;
/** Answer a save with what it saved, as if another browser's save landed right after it. */
let answerOnly = false;
const saves: Record<string, unknown>[] = [];
/** While set, the next save waits here before the server applies it: a slow link. */
let hold: Promise<void> | null = null;
let releaseHold: (() => void) | null = null;
function holdNextSave(): void {
  hold = new Promise<void>((r) => (releaseHold = r));
}

function emitState(): void {
  const frame = { data: JSON.stringify(state) };
  // The server pushing is state arriving outside any render: React's act scope.
  act(() => {
    for (const h of [...(listeners.get("stage:state-changed") ?? [])]) h(frame);
  });
}
const json = (status: number, value: unknown) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
  const path = String(input);
  const method = init?.method ?? "GET";
  if (method === "GET" && path.startsWith("/api/state")) return json(200, state);
  if (method === "POST" && path === "/api/bar-items") {
    const body = JSON.parse(init?.body ?? "{}") as { items?: string[]; mobileItems?: string[] };
    saves.push(body);
    if (hold) {
      const waiting = hold;
      hold = null; // only this one waits
      await waiting;
    }
    if (refuse) return json(400, { error: "refused for the test" });
    if (answerOnly) return json(200, { ...state, barItems: body.items ?? state.barItems, barMobileItems: body.mobileItems ?? state.barMobileItems });
    state = { ...state, barItems: body.items ?? state.barItems, barMobileItems: body.mobileItems ?? state.barMobileItems };
    emitState();
    return json(200, state);
  }
  return json(200, {});
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ContextBar } = await import("./context-bar.js");
const { CustomizeProvider, useCustomize } = await import("./customize-mode.js");
const { CustomizeTray } = await import("./sidebar-tray.js");
const { PageActionsProvider } = await import("./page-actions.js");
const { Toaster, TooltipProvider } = await import("../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { DEFAULT_BAR_ORDER, normalizeBarRows } = await import("./bar-items.js");
const { narrowWarning } = await import("./bar-editor.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  state = { views: [], outputs: [], appName: "Bar test app", sidebar: { sections: [], hidden: [] }, barItems: ["clock", "spacer", "live-timer"], barMobileItems: [] };
  refuse = false;
  answerOnly = false;
  hold = null;
  releaseHold = null;
  saves.length = 0;
});
afterEach(() => {
  // A save a failed test left waiting must not keep the run open.
  releaseHold?.();
  cleanup();
  resetStageState();
  resetReplayCache();
  listeners.clear();
});

let api: ReturnType<typeof useCustomize> | null = null;
beforeEach(() => {
  api = null;
});
function Probe() {
  const customize = useCustomize();
  React.useEffect(() => {
    api = customize;
  });
  return null;
}

/** The tray, mounted while the mode is on, as the shell does: it asks the
 *  provider itself rather than reading anything a test left behind. */
function TrayGate({ barOnPage }: { barOnPage: boolean }) {
  const { customizing } = useCustomize();
  return customizing ? React.createElement(CustomizeTray, { isMobile: false, barOnPage }) : null;
}

async function mountInMode({ barOnPage = true }: { barOnPage?: boolean } = {}): Promise<void> {
  // Async act: the hydrate read resolves on the microtasks right after the mount,
  // and it must land inside the scope or React reports it as an update outside act.
  await mountInAct(render,
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(
          PageActionsProvider,
          null,
          React.createElement(
            CustomizeProvider,
            null,
            React.createElement(Probe),
            // A console without the app's chrome draws no bar; the shell then
            // tells the tray so.
            barOnPage ? React.createElement(ContextBar, { active: null }) : null,
            React.createElement(TrayGate, { barOnPage }),
          ),
        ),
        React.createElement(Toaster),
      ),
    ),
  );
  await eventually(() => assert.ok(api, "the provider never rendered"));
  await act(async () => api!.open("bar"));
  // The strip shows what is saved: the hydrate has landed.
  const expected = (state.barItems as string[]).filter((id) => id !== "spacer").length;
  if (barOnPage) {
    await eventually(() => {
      const shown = document.querySelectorAll("[data-row-key]").length;
      assert.ok(shown >= expected && (expected > 0 || screen.queryByText("Drag something in.")), "the saved bar never reached the strip");
    });
  }
  await eventually(() => assert.ok(screen.getByRole("region", { name: "Customize" })));
}

/** The phone set, switched to in the tray. */
const toPhone = async () => {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Phone" })));
};

const chip = (label: string) => screen.queryByLabelText(`${label}: drag to move`);

describe("the context bar's editor", () => {
  test("a refused save puts the strip back", async () => {
    await mountInMode();
    await eventually(() => assert.ok(chip("Clock"), "the strip has no Clock to remove"));
    refuse = true;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove Clock" })));
    await eventually(() => assert.equal(saves.length, 1));
    await eventually(() => assert.ok(chip("Clock"), "the strip still shows a removal the server refused"));
  });

  test("the phone follows the desktop bar until its first edit, and Follow the desktop bar re-joins it", async () => {
    await mountInMode();
    await toPhone();
    await eventually(() => assert.ok(screen.getByText(/The phone is showing the desktop bar/)));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Recording" })));
    await eventually(() => assert.equal(saves.length, 1));
    // The phone set only: the desktop set is not sent at all.
    assert.equal("items" in saves[0], false, "a phone edit carried the desktop set too");
    assert.deepEqual(saves[0].mobileItems, normalizeBarRows(["clock", "spacer", "live-timer", "recording"]));
    await eventually(() => assert.ok(!screen.queryByText(/The phone is showing the desktop bar/), "the note stayed after the fork"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Follow the desktop bar" })));
    await eventually(() => assert.equal(saves.length, 2));
    assert.deepEqual(saves[1], { mobileItems: [] });
  });

  test("a used reading's tile is dimmed and adds nothing; a gap can be added again and again", async () => {
    await mountInMode();
    const used = screen.getByRole("button", { name: "Clock: already in the bar" });
    assert.equal(used.getAttribute("aria-disabled"), "true");
    await act(async () => fireEvent.click(used));
    assert.equal(saves.length, 0);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Space" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Space" })));
    await eventually(() => assert.equal(saves.length, 2));
  });

  test("Use the default set restores it, and Undo puts back what was there", async () => {
    await mountInMode();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Use the default set/ })));
    await eventually(() => assert.equal(saves.length, 1));
    assert.deepEqual(saves[0].items, normalizeBarRows(DEFAULT_BAR_ORDER));
    const undo = screen.getAllByRole("button", { name: "Undo" });
    await act(async () => fireEvent.click(undo[undo.length - 1]));
    await eventually(() => assert.equal(saves.length, 2));
    assert.deepEqual(saves[1].items, normalizeBarRows(["clock", "spacer", "live-timer"]));
  });

  test("switching to the Sidebar tab keeps the mode, and Done ends it", async () => {
    await mountInMode();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sidebar" })));
    assert.equal(api!.customizing, true);
    assert.ok(!screen.queryByLabelText("The context bar"), "the bar is still being edited on the Sidebar tab");
    assert.ok(screen.getByText(/Drag a page into the sidebar/));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Context bar" })));
    await eventually(() => assert.ok(screen.getByLabelText("The context bar")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Done" })));
    assert.equal(api!.customizing, false);
    assert.ok(!screen.queryByLabelText("The context bar"), "the bar is still being edited after Done");
  });
});

describe("the bar editor, beyond one set and one browser", () => {
  test("a page with no context bar says so, offers nothing, and a drop there places nothing", async () => {
    await mountInMode({ barOnPage: false });
    assert.ok(screen.getByText("This page has no context bar. Open Customize from a page that has one."));
    assert.ok(!screen.queryByRole("button", { name: "Add Clock" }), "tiles were offered with no bar to put them in");
    assert.ok(!screen.queryByRole("button", { name: /Use the default set/ }), "the default set was offered with no bar");
    assert.equal(saves.length, 0);
  });

  test("Undo after the default set puts back the set it was offered for, not the one on screen", async () => {
    state.barMobileItems = ["clock", "spacer"];
    await mountInMode();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Use the default set/ })));
    await eventually(() => assert.equal(saves.length, 1));
    assert.ok("items" in saves[0]);
    await toPhone();
    await eventually(() => assert.ok(chip("Clock"), "the phone's own set is not on screen"));
    const undo = screen.getAllByRole("button", { name: "Undo" });
    await act(async () => fireEvent.click(undo[undo.length - 1]));
    await eventually(() => assert.equal(saves.length, 2));
    assert.deepEqual(saves[1], { items: normalizeBarRows(["clock", "spacer", "live-timer"]) }, "the Undo wrote to the set on screen");
    // The phone's strip is untouched by an Undo for the desktop set.
    assert.ok(chip("Clock") && !chip("Live state and timer"), "the phone's strip was repainted with the desktop set");
  });

  test("Undo after the default set on a phone that was following puts the following back", async () => {
    await mountInMode();
    await toPhone();
    assert.ok(screen.getByText(/The phone is showing the desktop bar/));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Use the default set/ })));
    await eventually(() => assert.equal(saves.length, 1));
    assert.deepEqual(saves[0], { mobileItems: normalizeBarRows(DEFAULT_BAR_ORDER) });
    const undo = screen.getAllByRole("button", { name: "Undo" });
    await act(async () => fireEvent.click(undo[undo.length - 1]));
    await eventually(() => assert.equal(saves.length, 2));
    assert.deepEqual(saves[1], { mobileItems: [] }, "the phone was left forked");
    await eventually(() => assert.ok(screen.getByText(/The phone is showing the desktop bar/)));
  });

  test("a newer change retires the default set's Undo", async () => {
    await mountInMode();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Use the default set/ })));
    await eventually(() => assert.equal(saves.length, 1));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Space" })));
    await eventually(() => assert.equal(saves.length, 2));
    const offered = screen.queryAllByRole("button", { name: "Undo" }).map((u) => u.parentElement?.textContent ?? "");
    assert.ok(!offered.some((t) => t.includes("Restored the default bar")), "the older change's Undo is still on screen");
  });

  test("another browser's change is taken in, and kept by the next save", async () => {
    await mountInMode();
    await act(async () => {
      state = { ...state, barItems: ["clock", "spacer", "live-timer", "recording"] };
      emitState();
    });
    await eventually(() => assert.ok(chip("Recording"), "the other browser's change never reached the strip"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Space" })));
    await eventually(() => assert.equal(saves.length, 1));
    assert.ok((saves[0].items as string[]).includes("recording"), "this browser's save undid the other's");
  });

  test("the set chosen stays chosen across a change of tab", async () => {
    await mountInMode();
    await toPhone();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sidebar" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Context bar" })));
    await eventually(() => assert.equal(screen.getByRole("button", { name: "Phone" }).getAttribute("aria-pressed"), "true"));
  });

  test("emptying the phone's own set saves a spacer, never an empty list", async () => {
    // An empty phone set means "follow the desktop bar"; an emptied one is not that.
    state.barMobileItems = ["clock", "spacer"];
    await mountInMode();
    await toPhone();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove Clock" })));
    await act(async () => fireEvent.click(screen.getAllByRole("button", { name: "Remove Flexible space" })[0]));
    await eventually(() => assert.equal(saves.length, 2));
    assert.notDeepEqual(saves[1].mobileItems, [], "an emptied phone set was saved as following the desktop bar");
  });

  test("the 320 px probe is laid out only for a set a phone shows", async () => {
    const probe = () => document.querySelector(".-left-\\[9999px\\]");
    state.barMobileItems = ["clock", "spacer"];
    await mountInMode();
    assert.ok(!probe(), "the desktop set was measured though the phone has its own");
    await toPhone();
    await eventually(() => assert.ok(probe(), "the phone set was not measured"));
  });

  test("a strip of only gaps says to drag something in", async () => {
    state.barItems = ["spacer"];
    await mountInMode();
    await eventually(() => assert.ok(screen.getByText("Drag something in.")));
  });
});

describe("saves that are still out when the operator moves on", () => {
  /** The labels of the rows drawn in the strip, in order. */
  const rowLabels = () => [...document.querySelectorAll("[data-row-key]")].map((n) => n.getAttribute("aria-label"));

  test("switching to the phone set while a desktop save is out shows the phone's own set, and edits it", async () => {
    state.barMobileItems = ["recording", "spacer"];
    await mountInMode();
    holdNextSave();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Space" })));
    await eventually(() => assert.equal(saves.length, 1));
    await toPhone();
    await act(async () => releaseHold!());
    await eventually(() => assert.ok(chip("Recording"), "the phone's own set never reached the strip"));
    assert.equal(chip("Clock"), null, `the phone strip still shows the desktop rows: ${JSON.stringify(rowLabels())}`);
    // And the next phone edit is built on the phone's set, not on the desktop rows.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove Recording" })));
    await eventually(() => assert.equal(saves.length, 2));
    assert.deepEqual(saves[1], { mobileItems: normalizeBarRows(["spacer"]) });
  });

  test("another browser's change that lands while a save is out is taken in once it settles", async () => {
    await mountInMode();
    answerOnly = true;
    holdNextSave();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Recording" })));
    await eventually(() => assert.equal(saves.length, 1));
    // The other browser saved after this one; its broadcast gets here before this answer does.
    await act(async () => {
      state = { ...state, barItems: ["clock", "spacer", "live-timer", "streaming"] };
      emitState();
    });
    await act(async () => releaseHold!());
    await eventually(() => assert.ok(chip("Streaming"), "the other browser's change was dropped"));
    await eventually(() => assert.equal(chip("Recording"), null, "the strip kept an arrangement the server no longer holds"));
  });

  test("this save's own echo, arriving while a later edit is queued behind it, is not applied twice", async () => {
    await mountInMode();
    const spacers = () => rowLabels().filter((l) => l === "Space: drag to move").length;
    const before = spacers();
    holdNextSave();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Space" })));
    await eventually(() => assert.equal(saves.length, 1));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add Space" })));
    // The first save has taken, and its broadcast arrives while the second edit waits.
    await act(async () => {
      state = { ...state, barItems: saves[0].items as string[] };
      emitState();
    });
    // The second save runs after the first answers, so let both finish inside the scope.
    await act(async () => {
      releaseHold!();
      await new Promise((r) => setTimeout(r, 100));
    });
    assert.equal(saves.length, 2);
    assert.equal(spacers(), before + 2, `${JSON.stringify(rowLabels())}`);
  });
});

describe("Escape in the mode", () => {
  test("closes an open menu first, and leaves the mode alone", async () => {
    await mountInMode();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    try {
      await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
      assert.equal(api!.customizing, true, "Escape left the mode with a menu open");
    } finally {
      menu.remove();
    }
  });

  test("does nothing once something else has handled it", async () => {
    await mountInMode();
    const handled = (e: Event) => e.preventDefault();
    document.body.addEventListener("keydown", handled);
    try {
      await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
      assert.equal(api!.customizing, true, "Escape left the mode though it was already handled");
    } finally {
      document.body.removeEventListener("keydown", handled);
    }
  });

  test("mid-drag, cancels the drag and leaves the mode alone", async () => {
    await mountInMode();
    const c = chip("Clock")!;
    await act(async () => fireEvent.mouseDown(c, { button: 0, clientX: 10, clientY: 10 }));
    await act(async () => fireEvent.mouseMove(document, { clientX: 40, clientY: 10 }));
    await eventually(() => assert.ok(api!.bar?.dragging, "the drag never started"));
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    assert.equal(api!.customizing, true, "Escape mid-drag left the mode");
    await act(async () => fireEvent.mouseUp(document, { clientX: 40, clientY: 10 }));
  });
});

describe("the 320 px warning", () => {
  test("says nothing when nothing is cut", () => {
    assert.equal(narrowWarning({ over: 0, cut: [] }), null);
  });
  test("names the prose that is cut, and says to take it off", () => {
    assert.equal(
      narrowWarning({ over: 0, cut: ["Current plan item"] }),
      "On a 320px phone this runs out of room, and Current plan item will be cut short. Take it off the phone's bar to keep every reading whole.",
    );
    assert.equal(
      narrowWarning({ over: 0, cut: ["Service plan", "Current plan item"] }),
      "On a 320px phone this runs out of room, and Service plan and Current plan item will be cut short. Take one of them off the phone's bar to keep every reading whole.",
    );
  });
  test("with no prose left to give way, says how far over it is", () => {
    assert.equal(
      narrowWarning({ over: 12, cut: [] }),
      "On a 320px phone this is 12px too long even with every word given up, so a reading at the end would be cut off. Take an item off the phone's bar.",
    );
  });
});
