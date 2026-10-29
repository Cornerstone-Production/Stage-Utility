// An edit that lands after the inspector's click is undone one step at a time.
//
// Make it a cue (and an image upload, and Fit box to file) call the inspector's
// onConfig LATER than the click that started them, and onConfig is withHistory(...),
// whose pushHistory used to close over the layout as it was at the click. Anything
// typed meanwhile was then missing from the undo entry the late call pushed, so one
// Undo threw away the typing as well as the write. This drives the real LayoutEditor:
// click Make it a cue, type a label while the rule write is in flight, let it land, press
// Undo ONCE, save, and read what the layout holds.
//
// Delete the ref in pushHistory (snapshot the `objects` the callback closed over) and
// the saved Button has lost the label.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;
const realRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  return { width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
};

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../components/ui/index.js");
const { LayoutEditor } = await import("./layout-editor.js");
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

describe("Make it a cue, landing after the operator typed", () => {
  test("one Undo takes back the write and leaves what was typed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const f = stubFetchWithLog((url, init) => {
      if (url.includes("/api/automation/registry")) {
        return ok({ triggers: [], conditions: [], actions: [{ id: "display.refresh", label: "Refresh displays", params: [] }] });
      }
      if (url.endsWith("/api/automation/rules")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return gate.then(() => reply(201, { ...body, id: "rule-1", issues: [] }));
        }
        return ok({ rules: [], settings: {} });
      }
      return url.endsWith("/api/state") ? ok(DEFAULT_STAGE_STATE)
        : url.includes("/api/propresenter/instances") ? ok({ list: [], conn: {}, status: {} })
        : url.includes("/api/cues/manifest") ? ok({ version: 1, switches: [], buttons: [] })
        : url.includes("/api/layout-groups") ? ok([]) : ok({});
    });
    const saved: { objects: { config: Record<string, unknown> }[] }[] = [];
    const view = {
      id: "wall", name: "Test", kind: "custom", createdAt: new Date().toISOString(),
      layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [{ id: "o1", x: 0.1, y: 0.1, w: 0.3, h: 0.3, z: 1, config: { type: "action-button", actionId: "display.refresh", params: {} }, style: {} }] },
    };
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      render(
        React.createElement(RouterContextProvider as never, { router },
          React.createElement(QueryClientProvider, { client },
            React.createElement(TooltipProvider, null,
              React.createElement(LayoutEditor as never, {
                view, templates: [], startEditing: true,
                onSave: async (l: never) => { saved.push(l); },
                onSaveTemplate: async () => {}, onUpdateTemplate: async () => {}, onDeleteTemplate: async () => {},
              })))),
      );
      await settleAct();
      await settleAct();

      const make = () => screen.getByRole("button", { name: "Make it a cue" });
      await eventually(() => assert.equal(make().hasAttribute("disabled"), false));
      fireEvent.click(make());
      await settleAct();
      fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Walk" } });
      await settleAct();
      await act(async () => {
        release();
        await eventually(() => assert.ok(screen.queryByRole("button", { name: "Make it a cue" }) === null, "the rebind never landed"));
      });

      fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
      await settleAct();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await settleAct();

      assert.deepEqual(saved.at(-1)!.objects[0].config, { type: "action-button", actionId: "display.refresh", params: {}, label: "Walk" });
    } finally {
      f.restore();
    }
  });
});
