// The layout editor's own controls, outside the inspector, have names too: the
// Canvas size fields, and the name boxes in the Save as layout and Save as group
// dialogs. inspector-names.test.tsx sweeps the inspector; these live in
// layout-editor.tsx and are only reached by opening a popover or a dialog.
//
// Driven through the real LayoutEditor, wired the way layout-editor-group-write-
// fails.test.tsx wires it: a container pre-selected so Save as group is on
// screen, and every route the editor subscribes to answered with an empty 200.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom();

(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../components/ui/index.js");
const { LayoutEditor } = await import("./layout-editor.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
// The editor calls useBlocker, which needs a router in context even when
// nothing navigates.
const { RouterContextProvider, createRouter, createRootRoute, createMemoryHistory } =
  await import("@tanstack/react-router");
const testRouter = createRouter({
  routeTree: createRootRoute({}),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const VIEW: View = {
  id: "v1",
  name: "Test view",
  kind: "custom",
  createdAt: new Date().toISOString(),
  layout: {
    version: 1,
    canvas: { width: 1920, height: 1080, background: null },
    objects: [{ id: "o1", x: 0.1, y: 0.1, w: 0.3, h: 0.3, z: 1, config: { type: "container" }, style: {} }],
  },
} as unknown as View;

// useCueLive's manifest read needs switches/buttons arrays to iterate over, and
// the saved-groups library a list.
const CUE_MANIFEST = { version: 1, switches: [], buttons: [] };

async function mount(): Promise<ReturnType<typeof stubFetchWithLog>> {
  const f = stubFetchWithLog((url) =>
    url.includes("/api/cues/manifest") ? ok(CUE_MANIFEST) : url.includes("/api/layout-groups") ? ok([]) : ok({}),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      RouterContextProvider as unknown as React.FunctionComponent<Record<string, unknown>>,
      { router: testRouter },
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(LayoutEditor, {
            view: VIEW,
            slotsViews: [],
            templates: [],
            startEditing: true,
            onSave: async () => {},
            onSaveTemplate: async () => {},
            onUpdateTemplate: async () => {},
            onDeleteTemplate: async () => {},
          }),
        ),
      ),
    ),
  );
  await settle();
  await settle();
  return f;
}

const settleAct = async () => act(async () => settle());

test("the Canvas popover's size fields are named", async () => {
  const f = await mount();
  try {
    fireEvent.click(screen.getByRole("button", { name: /^Canvas/ }));
    await settleAct();
    assert.ok(screen.getByRole("textbox", { name: "Canvas width" }));
    assert.ok(screen.getByRole("textbox", { name: "Canvas height" }));
  } finally {
    f.restore();
  }
});

test("the Save as layout dialog's name box is named", async () => {
  const f = await mount();
  try {
    fireEvent.click(screen.getByRole("button", { name: /Save as layout/ }));
    await settleAct();
    assert.ok(within(screen.getByRole("dialog")).getByRole("textbox", { name: "Layout name" }));
  } finally {
    f.restore();
  }
});

test("the Save as group dialog's name box is named", async () => {
  const f = await mount();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Save as group" }));
    await settleAct();
    assert.ok(within(screen.getByRole("dialog")).getByRole("textbox", { name: "Group name" }));
  } finally {
    f.restore();
  }
});
