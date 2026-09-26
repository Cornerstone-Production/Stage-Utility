// The layout editor's saved-groups WRITES (save / delete), when the server
// refuses.
//
// The sibling READ (saved-groups.tsx, see layout-editor-saved-groups.test.tsx)
// was rewritten this release to surface a failed read as an ErrorNote and a
// [layout-editor] log line. The two WRITES beside it — saveSelectedAsGroup and
// deleteGroup, both in layout-editor.tsx — were edited in the same change
// (setGroups -> savedGroups.replace) and kept `catch { /* ignore */ }`: a
// failed save closed the name dialog as if it had saved, with nothing added to
// the library and nothing on /log; a failed delete left the group in the list
// with no explanation either.
//
// Driven through the REAL LayoutEditor (not an extracted helper): a container
// object is pre-selected so the inspector's "Save as group" button is already
// on screen, and every route this heavy component subscribes to (the editor
// enables every integration's channel, per useLayoutData's own comment) is
// answered with an empty 200 except the one under test.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider, Toaster } = await import("../components/ui/index.js");
const { LayoutEditor } = await import("./layout-editor.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");
// The editor calls useBlocker (unsaved-changes guard), which needs a router in
// context even when nothing navigates. A real RouterContextProvider around a
// router with one root route — see import-layout.test.tsx for why not a route
// tree, and why not the app's own router.
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
    objects: [
      { id: "o1", x: 0.1, y: 0.1, w: 0.3, h: 0.3, z: 1, config: { type: "container" }, style: {} },
    ],
  },
} as unknown as View;

type Answer = "fail" | LayoutGroup[];

// useCueLive's manifest read needs switches/buttons arrays to iterate over —
// an empty {} throws inside fromManifest and takes the whole editor down.
const CUE_MANIFEST = { version: 1, switches: [], buttons: [] };

function stubFetch(onLayoutGroups: (method: string) => Answer) {
  return stubFetchWithLog((url, init) => {
    if (url.includes("/api/layout-groups")) {
      const method = init?.method ?? "GET";
      const answer = onLayoutGroups(method);
      if (answer === "fail") throw new TypeError("fetch failed");
      return ok(answer);
    }
    if (url.includes("/api/cues/manifest")) return ok(CUE_MANIFEST);
    return ok({});
  });
}

async function mount(): Promise<void> {
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
          React.createElement(Toaster),
        ),
      ),
    ),
  );
  await settle();
  await settle();
}

const settleAct = async () => act(async () => settle());

test("a failed save leaves the name dialog open, toasts, and reaches the log", async () => {
  const f = stubFetch((method) => (method === "POST" ? "fail" : []));
  try {
    await mount();
    const saveAsGroup = screen.getByRole("button", { name: "Save as group" });
    fireEvent.click(saveAsGroup);
    await settleAct();

    const nameInput = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(nameInput, { target: { value: "Lower third" } });
    await settleAct();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settleAct();

    assert.equal(!!screen.queryByRole("dialog"), true, "a failed save closed the name dialog");
    assert.match(document.body.textContent ?? "", /Couldn't save the group/i);
    assert.ok(
      f.logs.some((l) => l.tag === "layout-editor" && /couldn't save a group/i.test(l.message)),
      `expected a [layout-editor] line naming the failed save — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("control: a save that succeeds closes the dialog and adds the group", async () => {
  const f = stubFetch((method) => (method === "POST" ? [{ id: "g1", name: "Lower third", object: {} } as unknown as LayoutGroup] : []));
  try {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Save as group" }));
    await settleAct();
    const nameInput = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(nameInput, { target: { value: "Lower third" } });
    await settleAct();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settleAct();

    assert.equal(!!screen.queryByRole("dialog"), false, "a successful save left the name dialog open");
    assert.equal(alerts(), "");
    assert.equal(!!screen.queryByText("Lower third"), true, "the saved group did not appear in the library");
  } finally {
    f.restore();
  }
});

let groupsAfterFailedDelete: LayoutGroup[] = [{ id: "g1", name: "Lower third", object: {} } as unknown as LayoutGroup];

test("a failed delete leaves the group in the list, toasts, and reaches the log", async () => {
  const f = stubFetchWithLog((url, init) => {
    if (url.includes("/api/layout-groups")) {
      const method = init?.method ?? "GET";
      if (method === "GET") return ok(groupsAfterFailedDelete);
      if (method === "DELETE") throw new TypeError("fetch failed");
    }
    if (url.includes("/api/cues/manifest")) return ok(CUE_MANIFEST);
    return ok({});
  });
  try {
    await mount();
    assert.equal(!!screen.queryByText("Lower third"), true, "the group was not offered to delete");
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    await settleAct();

    assert.equal(!!screen.queryByText("Lower third"), true, "a failed delete removed the group from view");
    assert.match(document.body.textContent ?? "", /Couldn't delete the group/i);
    assert.ok(
      f.logs.some((l) => l.tag === "layout-editor" && /couldn't delete a group/i.test(l.message)),
      `expected a [layout-editor] line naming the failed delete — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});
