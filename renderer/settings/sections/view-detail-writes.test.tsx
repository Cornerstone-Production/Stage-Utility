// view-detail-writes.test.tsx — the two fire-and-forget writes ViewDetail
// issues directly (not through handlers): the console chrome toggle
// (views:setHideChrome) and the ServiceCue view Columns picker
// (views:setServiceCueLayout). Both used to be `void invoke(...)` with no
// `.catch` — a rejected POST reached neither the screen nor /log, and the
// control just silently did nothing (its value comes from the `view` prop,
// so it snaps back with no explanation once the parent re-renders).
//
// Driven through the real component with a stubbed fetch. NOTHING BELOW PASSES
// A DOM NODE AS AN ASSERT OPERAND — node:assert inspects `actual` to build its
// failure message, and inspecting a live jsdom element does not finish in any
// useful time. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { ViewDetail } = await import("./view-detail.js");
const { TooltipProvider, Toaster, ConfirmHost } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** The newest toast only. Toasts linger across tests in one jsdom document, so
 *  reading document.body lets a PREVIOUS test's message satisfy an assertion
 *  about this one. */
const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const lastToast = () => {
  const all = [...document.querySelectorAll(".text-footnote")];
  return all.length ? text(all[all.length - 1]) : "NO TOAST";
};

const CONSOLE_VIEW = {
  id: "v1",
  name: "Booth console",
  // "stage", not "custom": a console-surface custom view also renders the
  // LayoutEditor, which needs a router context this test does not set up.
  // viewSurface() only reads `surface`, so any kind exercises the toggle.
  kind: "stage",
  surface: "console",
  createdAt: "2026-01-01T00:00:00.000Z",
  hideChrome: false,
} as View;

const SERVICE_CUE_VIEW = {
  id: "v2",
  name: "Booth script",
  kind: "script",
  createdAt: "2026-01-01T00:00:00.000Z",
  serviceCueLayoutId: null,
} as View;

/** Only what these branches read; everything else is inert here. */
function props(view: View): Parameters<typeof ViewDetail>[0] {
  return {
    view,
    canDelete: true,
    stageState: { views: [view], outputs: [] },
    wirelessChannels: [],
    localSlots: [],
    slotsDirty: false,
    isSavingSlots: false,
    slotsPreview: null,
    slotsTargetTypeName: null,
    slotPresets: [],
    layoutTemplates: [],
    slotsTargetSide: null,
    slotsTargetLabel: null,
    slotsTargetHasPlan: false,
    slotsTargetHasOverride: false,
    handlers: {},
  } as unknown as Parameters<typeof ViewDetail>[0];
}

function mount(view: View, outputs: Partial<Output>[] = []) {
  const p = props(view);
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ViewDetail, { ...p, stageState: { ...p.stageState, outputs } } as unknown as Parameters<typeof ViewDetail>[0]),
      React.createElement(Toaster),
      React.createElement(ConfirmHost),
    ),
  );
}

test("a failed console-chrome toggle toasts, rather than doing nothing silently", async () => {
  const f = stubFetchWithLog((url, init) => {
    if (init?.method === "PATCH" && url.includes(`/api/views/${CONSOLE_VIEW.id}`)) return reply(500, { error: "boom" });
    if (url.includes("/api/servicecue/layouts")) return ok([]);
    return ok({});
  });
  try {
    mount(CONSOLE_VIEW);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Hide the app's bars on this console/i }));
    await settle();
    assert.match(lastToast(), /Could not change this console's chrome/i);
  } finally {
    f.restore();
  }
});

test("a failed Columns save toasts, rather than doing nothing silently", async () => {
  const f = stubFetchWithLog((url, init) => {
    if (url.includes("/api/servicecue/layouts")) return ok([{ id: "svl-audio", name: "Audio", order: 0 }]);
    if (init?.method === "PATCH" && url.includes(`/api/views/${SERVICE_CUE_VIEW.id}`)) return reply(500, { error: "boom" });
    return ok({});
  });
  try {
    mount(SERVICE_CUE_VIEW);
    await settle();
    await settle();
    fireEvent.change(screen.getByRole("combobox", { name: "Columns" }), { target: { value: "svl-audio" } });
    await settle();
    assert.match(lastToast(), /Could not change this view's columns/i);
  } finally {
    f.restore();
  }
});

test("deleting a view names a screen that has no name by its id, not as an empty pair of quotes", async () => {
  const f = stubFetchWithLog(() => ok({}));
  try {
    mount(CONSOLE_VIEW, [{ id: "display-7", name: "", viewId: "v1" }, { id: "o2", name: "Stage panel", viewId: "v1" }]);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await settle();
    const dialog = text(document.querySelector('[role="alertdialog"]')!);
    assert.match(dialog, /"display-7" and "Stage panel" show it/);
    assert.equal(/""/.test(dialog), false, "an unnamed screen was named with empty quotes");
  } finally {
    f.restore();
  }
});

// Deleting a view un-routes every screen showing it. A control surface's screens
// were live, so the operator is told its buttons stop working, not only that the
// screens lose their view.
test("deleting a console's view says its screens' buttons will stop working; a wall view's does not", async () => {
  const f = stubFetchWithLog(() => ok({}));
  try {
    const screens = [{ id: "o1", name: "Booth panel", viewId: "v1" }, { id: "o2", name: "Stage panel", viewId: "v1" }, { id: "o3", name: "Elsewhere", viewId: "other" }];
    mount(CONSOLE_VIEW, screens);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await settle();
    const dialog = text(document.querySelector('[role="alertdialog"]')!);
    assert.match(dialog, /"Booth panel" and "Stage panel" show it, and will show nothing until you pick another view\. Their buttons stop working\./);
    assert.equal(/Elsewhere/.test(dialog), false, "a screen showing another view was named");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    cleanup();

    mount({ ...CONSOLE_VIEW, surface: "display" } as View, screens);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await settle();
    const wall = text(document.querySelector('[role="alertdialog"]')!);
    assert.match(wall, /will show nothing until you pick another view\./);
    assert.equal(/buttons will stop working/.test(wall), false);
  } finally {
    f.restore();
  }
});
