// view-detail-writes.test.tsx — the two fire-and-forget writes ViewDetail
// issues directly (not through handlers): the console chrome toggle
// (views:setHideChrome) and the Script view Columns picker
// (views:setScriptViewLayout). Both used to be `void invoke(...)` with no
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
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");

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

const SCRIPT_VIEW = {
  id: "v2",
  name: "Booth script",
  kind: "script",
  createdAt: "2026-01-01T00:00:00.000Z",
  scriptViewLayoutId: null,
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

function mount(view: View) {
  return render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ViewDetail, props(view)),
      React.createElement(Toaster),
    ),
  );
}

test("a failed console-chrome toggle toasts, rather than doing nothing silently", async () => {
  const f = stubFetchWithLog((url, init) => {
    if (init?.method === "PATCH" && url.includes(`/api/views/${CONSOLE_VIEW.id}`)) return reply(500, { error: "boom" });
    if (url.includes("/api/scriptview/layouts")) return ok([]);
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
    if (url.includes("/api/scriptview/layouts")) return ok([{ id: "svl-audio", name: "Audio", order: 0 }]);
    if (init?.method === "PATCH" && url.includes(`/api/views/${SCRIPT_VIEW.id}`)) return reply(500, { error: "boom" });
    return ok({});
  });
  try {
    mount(SCRIPT_VIEW);
    await settle();
    await settle();
    fireEvent.change(screen.getByRole("combobox", { name: "Columns" }), { target: { value: "svl-audio" } });
    await settle();
    assert.match(lastToast(), /Could not change this view's columns/i);
  } finally {
    f.restore();
  }
});
