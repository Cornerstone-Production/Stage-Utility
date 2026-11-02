// The widget shelf inside the real layout editor: it sits under the canvas, there is no
// popover any more, a tile click adds, Cmd/Ctrl-F opens its search (and leaves another
// text field's find alone), "Hide what is not set up" dims-and-empties groups, and a
// fold survives a remount.
//
// Wired the way layout-editor-names.test.tsx wires the editor.
//
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
  // The fold is remembered per browser; one test's fold must not open the next folded.
  localStorage.clear();
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

// Elements are compared with `===` inside assert.ok, never assert.equal: a failing
// equal() on two DOM nodes builds a diff of both trees and stalls the run for ~25s.
const settleAct = async () => act(async () => settle());


const keydown = (target: Element, init: KeyboardEventInit) => {
  const e = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const layerNames = () => screen.getAllByRole("button").filter((b) => b.getAttribute("draggable") === "true" && !b.getAttribute("aria-label")).map((b) => b.textContent);

test("the shelf sits under the canvas, and nothing opens over it", async () => {
  const f = await mount();
  try {
    const shelf = screen.getByRole("region", { name: "Widgets" });
    // The centre column holds the canvas cell and then the shelf, and the
    // inspector ("Layers") is beside it, not in it.
    const column = shelf.parentElement!;
    assert.ok(column.lastElementChild === shelf, "the shelf is the last thing in its column");
    assert.ok(shelf.previousElementSibling, "the canvas cell comes before it");
    assert.equal(column.textContent?.includes("Layers"), false, "the shelf shares a column with the inspector");
    fireEvent.click(screen.getByRole("button", { name: "Add an object" }));
    await settleAct();
    assert.ok(document.querySelector("[data-radix-popper-content-wrapper]") === null, "no popover");
    assert.ok(screen.queryByRole("dialog") === null, "no dialog");
  } finally {
    // Unmount first: a failing assertion would otherwise leave the editor's event
    // stream reconnecting against a restored fetch until the run times out.
    cleanup();
    f.restore();
  }
});

test("clicking a tile adds that widget to the layout", async () => {
  const f = await mount();
  try {
    const before = layerNames().length;
    fireEvent.click(within(screen.getByRole("region", { name: "Widgets" })).getByRole("button", { name: /^Clock:/ }));
    await settleAct();
    assert.equal(layerNames().length, before + 1);
    assert.ok(layerNames().includes("Clock"), `layers: ${layerNames().join(", ")}`);
  } finally {
    // Unmount first: a failing assertion would otherwise leave the editor's event
    // stream reconnecting against a restored fetch until the run times out.
    cleanup();
    f.restore();
  }
});

test("Cmd+F and Ctrl+F focus the shelf's search and stop the browser's find", async () => {
  const f = await mount();
  try {
    const box = screen.getByLabelText("Search widgets");
    for (const init of [{ metaKey: true }, { ctrlKey: true }]) {
      (box as HTMLElement).blur();
      const e = keydown(document.body, { key: "f", ...init });
      await settleAct();
      assert.equal(e.defaultPrevented, true, "preventDefault not called");
      assert.ok(document.activeElement === box, "the search box is not focused");
    }
  } finally {
    // Unmount first: a failing assertion would otherwise leave the editor's event
    // stream reconnecting against a restored fetch until the run times out.
    cleanup();
    f.restore();
  }
});

test("Cmd+F brings the whole shelf into view, not just its search box", async () => {
  // On a short window the shelf sits below the fold; focus alone would scroll only
  // the box into view and leave the widgets under it off screen.
  const scrolled: Element[] = [];
  const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
  const saved = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element) { scrolled.push(this); };
  const f = await mount();
  try {
    keydown(document.body, { key: "f", metaKey: true });
    await settleAct();
    const shelf = screen.getByRole("region", { name: "Widgets" });
    assert.ok(scrolled.includes(shelf), "the shelf was not scrolled into view");
  } finally {
    cleanup();
    f.restore();
    proto.scrollIntoView = saved;
  }
});

test("Cmd+F does not steal find from another text field", async () => {
  const f = await mount();
  try {
    const other = document.createElement("input");
    other.type = "text";
    document.body.appendChild(other);
    other.focus();
    const e = keydown(other, { key: "f", metaKey: true });
    await settleAct();
    assert.equal(e.defaultPrevented, false);
    assert.ok(document.activeElement !== screen.getByLabelText("Search widgets"), "focus was moved into the shelf");
    other.remove();
  } finally {
    // Unmount first: a failing assertion would otherwise leave the editor's event
    // stream reconnecting against a restored fetch until the run times out.
    cleanup();
    f.restore();
  }
});

test("Cmd+F unfolds a folded shelf and focuses its search", async () => {
  const f = await mount();
  try {
    fireEvent.click(screen.getByRole("button", { name: /^Fold/ }));
    await settleAct();
    assert.ok(screen.queryByLabelText("Search widgets") === null, "the search box should not be drawn");
    keydown(document.body, { key: "f", metaKey: true });
    await settleAct();
    assert.ok(document.activeElement === screen.getByLabelText("Search widgets"), "the search box is not focused");
  } finally {
    // Unmount first: a failing assertion would otherwise leave the editor's event
    // stream reconnecting against a restored fetch until the run times out.
    cleanup();
    f.restore();
  }
});

test("the toolbar's Add object does what Cmd+F does", async () => {
  const f = await mount();
  try {
    fireEvent.click(screen.getByRole("button", { name: /^Fold/ }));
    await settleAct();
    fireEvent.click(screen.getByRole("button", { name: "Add an object" }));
    await settleAct();
    assert.ok(document.activeElement === screen.getByLabelText("Search widgets"), "the search box is not focused");
  } finally {
    // Unmount first: a failing assertion would otherwise leave the editor's event
    // stream reconnecting against a restored fetch until the run times out.
    cleanup();
    f.restore();
  }
});

test("Hide what is not set up removes unconfigured widgets and dims the groups left empty", async () => {
  const f = await mount();
  try {
    const shelf = screen.getByRole("region", { name: "Widgets" });
    const nav = () => within(shelf).getByRole("navigation", { name: "Widget groups" });
    const groups = () => [...nav().querySelectorAll("button")];
    assert.equal(groups().filter((b) => b.getAttribute("data-empty") === "true").length, 0, "with everything shown no group is empty");
    const tiles = () => shelf.querySelectorAll("[data-section] button").length;
    const all = tiles();
    fireEvent.click(within(shelf).getByRole("checkbox", { name: /Hide what is not set up/ }));
    await settleAct();
    assert.ok(tiles() < all, `hiding removed nothing (${all} -> ${tiles()})`);
    assert.ok(groups().some((b) => b.getAttribute("data-empty") === "true"), "a group with no configured widget should be dimmed");
    assert.equal(groups().length, 13, "every group stays in the list");
  } finally {
    // Unmount first: a failing assertion would otherwise leave the editor's event
    // stream reconnecting against a restored fetch until the run times out.
    cleanup();
    f.restore();
  }
});

test("a folded shelf stays folded when the editor is opened again", async () => {
  const f = await mount();
  try {
    fireEvent.click(screen.getByRole("button", { name: /^Fold/ }));
    await settleAct();
    assert.ok(screen.queryByLabelText("Search widgets") === null, "the shelf did not fold");
    // The editor is closed and opened again: a fresh mount over the same storage.
    cleanup();
    await mount();
    const folded = screen.queryByLabelText("Search widgets") === null;
    assert.equal(folded, true, "the fold was not remembered");
    assert.ok(screen.getByRole("button", { name: /^Widgets/ }));
  } finally {
    cleanup();
    f.restore();
  }
});
