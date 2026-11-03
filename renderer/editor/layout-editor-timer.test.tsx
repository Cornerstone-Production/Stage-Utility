// What the layout editor WRITES for an object saved as one of the retired timers.
//
// timer-inspector.test.tsx drives the Inspector, which is handed an onConfig and
// shows only what it is asked to write. The write itself — updateConfig and Reset
// look in layout-editor.tsx — is upstream of it, and a Timer that opens right but
// is saved back as the old type with the old type's style would pass every test
// there. So this drives the real LayoutEditor and reads what it hands onSave.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;
// The canvas draws nothing at a zero-size pane, and jsdom lays nothing out.
const realRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
};
// Readout sizes its rows from its own box, which jsdom leaves at 0.
for (const [prop, px] of [["offsetHeight", 240], ["offsetWidth", 520]] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { get: () => px, configurable: true });
}

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../components/ui/index.js");
const { LayoutEditor } = await import("./layout-editor.js");
const { defaultStyle } = await import("../main/layout-objects.js");
const { DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { RouterContextProvider, createRouter, createRootRoute, createMemoryHistory } = await import("@tanstack/react-router");
const router = createRouter({ routeTree: createRootRoute({}), history: createMemoryHistory({ initialEntries: ["/"] }) });

after(() => {
  Element.prototype.getBoundingClientRect = realRect;
  unmountAndTeardown(cleanup, teardown);
});
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const settleAct = async () => act(async () => settle());

/** Opens the editor on one object of `config`; `restore` puts fetch back. */
async function open(viewId: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
  const saved: LayoutDTO[] = [];
  const view = {
    id: viewId, name: "Test", kind: "custom", createdAt: new Date().toISOString(),
    layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [{ id: "o1", x: 0.1, y: 0.1, w: 0.3, h: 0.3, z: 1, config, style: { color: "#ff0000", fontSize: 0.42 }, ...extra }] },
  } as unknown as View;
  const f = stubFetchWithLog((url) => {
    const path = url.split("?")[0];
    const hit = Object.entries(answers).find(([k]) => path.endsWith(k));
    return hit ? ok(hit[1])
      : url.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE)
      : url.includes("/api/propresenter/instances") ? ok({ list: [], conn: {}, status: {} })
      : url.includes("/api/cues/manifest") ? ok({ version: 1, switches: [], buttons: [] })
      : url.includes("/api/layout-groups") ? ok([]) : ok({});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const utils = render(
    React.createElement(RouterContextProvider as never, { router },
      React.createElement(QueryClientProvider, { client },
        React.createElement(TooltipProvider, null,
          React.createElement(LayoutEditor as never, {
            view, templates: [], startEditing: true,
            onSave: async (l: LayoutDTO) => { saved.push(l); },
            onSaveTemplate: async () => {}, onUpdateTemplate: async () => {}, onDeleteTemplate: async () => {},
          })))),
  );
  await settleAct();
  await settleAct();
  return { ...utils, saved, restore: f.restore };
}

/** Opens the editor, edits the object, saves, and returns what was saved. */
async function editAndSave(viewId: string, config: Record<string, unknown>, edit: () => void | Promise<void>, extra: Record<string, unknown> = {}) {
  const e = await open(viewId, config, extra);
  try {
    await edit();
    await settleAct();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settleAct();
    return e.saved.at(-1)!.objects[0];
  } finally {
    e.restore();
  }
}

describe("editing a retired timer in the layout editor", () => {
  const toggleHide = () => void fireEvent.click(screen.getByRole("switch", { name: "Hide when idle" }));

  test("writes a Timer, not the old type", async () => {
    const o = await editAndSave("wall", { type: "countdown-timer", warnSeconds: 45, caption: "Time left" }, toggleHide);
    assert.deepEqual(o.config, {
      type: "timer", source: "service", nextItem: false, redOnOverrun: true, warnSeconds: 45, caption: "Time left", hideWhenIdle: true,
    });
  });

  test("writes no Home tile onto an object on a wall", async () => {
    const o = await editAndSave("wall", { type: "pp-timer", caption: "Stage timer" }, toggleHide);
    assert.equal("home" in o, false, "a wall object gained a Home tile");
  });

  test("on Home, keeps the tile the retired card held", async () => {
    const o = await editAndSave("home", { type: "home-live-status" }, toggleHide);
    assert.deepEqual(o.home, { size: "xl", when: "live" });
  });

  test("Reset look applies the Timer's default style, not the old type's", async () => {
    const o = await editAndSave("wall", { type: "baptism-timer", field: "live" }, () => void fireEvent.click(screen.getByRole("button", { name: "Reset to default look" })),
    );
    assert.deepEqual(o.style, defaultStyle("timer"));
    assert.notDeepEqual(o.style, defaultStyle("baptism-timer"));
    assert.equal(o.config.type, "baptism-timer", "Reset look rewrote the settings, which it must not");
  });
});

describe("the editor canvas draws a Timer from live data", () => {
  // The canvas builds its own render context (the `ctx={{ ...data, ... }}` in
  // layout-editor.tsx), so a flag it forgets to thread reads as "not heard from
  // yet" and the Timer would be a dash in the editor and nowhere else.
  const now = Date.now();
  const live = {
    "/api/pco/live": {
      mode: "item", currentItemId: "i1", label: "Message", lengthSec: 600,
      liveStartAt: new Date(now - 120_000).toISOString(), targetAt: null, serverNow: new Date(now).toISOString(),
      currentItemTitle: "Message", nextItemTitle: null, serviceTimeId: null, serviceTimeStartsAt: null,
    },
    "/api/propresenter/status": { connected: true, timers: [{ name: "Stage", time: "00:03:00", state: "running" }] },
  };
  const canvasText = () => document.body.textContent ?? "";

  test("a service Timer's time", async () => {
    const e = await open("wall", { type: "timer", source: "service" }, {}, live);
    try {
      await eventually(() => assert.match(canvasText(), /(8:00|7:5\d)/, "the editor service Timer never drew its time"));
    } finally {
      e.restore();
    }
  });

  test("a ProPresenter Timer's time", async () => {
    const e = await open("wall", { type: "timer", source: "propresenter" }, {}, live);
    try {
      await eventually(() => assert.match(canvasText(), /00:03:00/, "the editor's ProPresenter Timer never drew its time"));
    } finally {
      e.restore();
    }
  });
});
