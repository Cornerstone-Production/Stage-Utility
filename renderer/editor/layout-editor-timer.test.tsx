// What the layout editor WRITES for an object saved as one of the retired timers.
//
// timer-inspector.test.tsx drives the Inspector, which is handed an onConfig and
// shows only what it is asked to write. The write itself — updateConfig and Reset
// look in layout-editor.tsx — is upstream of it, and a Timer that opens right but
// is saved back as the old type with the old type's style would pass every test
// there. So this drives the real LayoutEditor and reads what it hands onSave.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

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

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const settleAct = async () => act(async () => settle());

/** Opens an editor on one object of `config`, edits it, and returns what was saved. */
async function editAndSave(viewId: string, config: Record<string, unknown>, edit: () => void | Promise<void>, extra: Record<string, unknown> = {}) {
  const saved: LayoutDTO[] = [];
  const view = {
    id: viewId, name: "Test", kind: "custom", createdAt: new Date().toISOString(),
    layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [{ id: "o1", x: 0.1, y: 0.1, w: 0.3, h: 0.3, z: 1, config, style: { color: "#ff0000", fontSize: 0.42 }, ...extra }] },
  } as unknown as View;
  const f = stubFetchWithLog((url) =>
    url.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE) : url.includes("/api/propresenter/instances") ? ok({ list: [], conn: {}, status: {} }) : url.includes("/api/cues/manifest") ? ok({ version: 1, switches: [], buttons: [] }) : url.includes("/api/layout-groups") ? ok([]) : ok({}),
  );
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      React.createElement(RouterContextProvider as never, { router },
        React.createElement(QueryClientProvider, { client },
          React.createElement(TooltipProvider, null,
            React.createElement(LayoutEditor as never, {
              view, slotsViews: [], templates: [], startEditing: true,
              onSave: async (l: LayoutDTO) => { saved.push(l); },
              onSaveTemplate: async () => {}, onUpdateTemplate: async () => {}, onDeleteTemplate: async () => {},
            })))),
    );
    await settleAct();
    await settleAct();
    await edit();
    await settleAct();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settleAct();
    return saved.at(-1)!.objects[0];
  } finally {
    f.restore();
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
