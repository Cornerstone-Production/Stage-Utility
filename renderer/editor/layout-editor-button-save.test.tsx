// The layout editor's Save, against a Button whose command is still being written.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - SAVE WAITS FOR A BUTTON'S PICK OR TYPED ACTION FIELD. An App action field is written
//    after a typing delay (500 ms), and the write binds the Button on its own: a Save inside
//    that window stored the layout with the Button unbound, and the bind then landed on an
//    editor that had left edit mode. Home's sheet already waited; the inspector did not.
//  - A REFUSED WRITE STORES NOTHING. The operator was told the Button is not bound, and a
//    Save that stored it anyway would read as saved.
//
// Wired the way layout-editor-shelf.test.tsx wires the editor, with the Button tests' server.
import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import type { LayoutObject, View } from "@main/types/views.js";
import { eventually, installRenderDom, unmountAndTeardown } from "../test-dom.js";
import { serve } from "../test-fixtures/button-server.js";
import { reply } from "../test-fixtures/fetch-log.js";
import { NoStream } from "../test-fixtures/no-stream.js";

const teardown = installRenderDom();
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../components/ui/index.js");
const { LayoutEditor } = await import("./layout-editor.js");
const { timing } = await import("./action-pane.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
const { RouterContextProvider, createRouter, createRootRoute, createMemoryHistory } = await import("@tanstack/react-router");
const testRouter = createRouter({
  routeTree: createRootRoute({}),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  timing.fieldWriteMs = 500;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetStageState();
  resetReplayCache();
  timing.fieldWriteMs = 0;
});

const VIEW = {
  id: "booth",
  name: "Booth console",
  kind: "custom",
  createdAt: new Date().toISOString(),
  layout: {
    version: 1,
    canvas: { width: 1920, height: 1080, background: null },
    objects: [{ id: "o1", x: 0.1, y: 0.1, w: 0.3, h: 0.3, z: 1, config: { type: "cue-button", cue: "" }, style: {} }],
  },
} as unknown as View;

function mount(serveOpts: Parameters<typeof serve>[0] = {}) {
  const server = serve({
    ...serveOpts,
    extra: (url) => (url.includes("/api/layout-groups") ? reply(200, []) : undefined),
  });
  const saved: LayoutObject[][] = [];
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
            templates: [],
            startEditing: true,
            onSave: async (layout: { objects: LayoutObject[] }) => {
              saved.push(layout.objects);
            },
            onSaveTemplate: async () => {},
            onUpdateTemplate: async () => {},
            onDeleteTemplate: async () => {},
          }),
        ),
      ),
    ),
  );
  return { server, saved };
}

/** Select the Button, change its label (so the editor is dirty), choose App action, type a message. */
async function typeAMessage() {
  const layer = await eventually(() => {
    const l = screen.getAllByRole("button").find((b) => b.getAttribute("draggable") === "true" && !b.getAttribute("aria-label"));
    assert.ok(l, "no layer row");
    return l;
  });
  fireEvent.click(layer);
  await eventually(() => assert.ok(document.querySelector('[aria-label="Presses"]')));
  fireEvent.change(document.querySelector('input[aria-label="Label"]') ?? screen.getByLabelText("Label"), { target: { value: "Go" } });
  const app = [...document.querySelectorAll('[aria-label="Presses"] button')].find((x) => x.textContent === "App action")!;
  fireEvent.click(app);
  await eventually(() => assert.ok(document.querySelector('[role="option"]')));
  fireEvent.click([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Write a log message")!);
  await eventually(() => assert.ok(document.querySelector('[aria-label="Message"]')));
  fireEvent.change(document.querySelector('[aria-label="Message"]')!, { target: { value: "Hello" } });
}

const cueOf = (objects: LayoutObject[]) => (objects[0]!.config as { cue: string }).cue;

test("Save inside a typed field's delay waits for it, and stores the Button bound to its command", async () => {
  const { server, saved } = mount();
  await typeAMessage();
  // Well inside the 500 ms the field waits before writing.
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await eventually(() => assert.equal(saved.length, 1));
  assert.equal(server.posts.length, 1, "the typed field was never written");
  assert.match(cueOf(saved[0]!), /^btn_go/, "the layout was stored with the Button unbound");
});

test("Save stores nothing when the command could not be written", async () => {
  const { server, saved } = mount({ refuse: true });
  await typeAMessage();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await eventually(() => assert.equal(server.posts.length, 1));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(saved, [], "a layout with an unbound Button was stored after the write failed");
});
