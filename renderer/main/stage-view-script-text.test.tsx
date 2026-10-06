// The kiosk's script display takes its text size from the server, and keeps `?text=` there.
//
// servicecue-view-text-size.test.tsx drives the display component with a size
// handed to it. This is the other half: that StageView, the thing a Pi opens at
// /display-1 and the Screens page opens at /preview-<view>?output=<display>, hands
// it the right one — the display's own kept size for both, and `?text=` kept
// only by a real display. Without it the preview would draw 100% beside a
// display at 200%, and nothing on the page would say so.
//
// Driven through the real StageView, routed by `/api/state`, at a real path in
// window.location. NOT asserted: that the rundown is visibly larger (jsdom has no
// layout; driven in a browser). NOTHING BELOW PASSES A DOM NODE AS AN ASSERT
// OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { StageView } = await import("./stage-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { displayTextSizeKey, readStoredSize } = await import("./servicecue-text-size.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const STATE = {
  serviceTypeId: "st1",
  serviceTypeName: "Weekend",
  planId: "p1",
  planTitle: "A plan",
  planSeriesTitle: null,
  planDates: null,
  showQr: false,
  remoteUrl: null,
  appName: "Stage Utility",
  appLogo: null,
  appLogoMonochrome: false,
  pcoConfigured: true,
  hourCycle: "12h",
  views: [{ id: "v1", name: "The view", kind: "script" }],
  outputs: [{ id: "display-1", name: "Stage left", viewId: "v1" }],
  resolvedByOutput: { "display-1": { viewId: "v1", kind: "script", ndiSource: null, viewName: "The view", blackout: false, locked: false, hideTopBar: false } },
  slotsByView: {},
  slotsByLayoutObject: {},
  notesByObject: {},
  barItems: [],
  savedColors: [],
  captionChannelColors: {},
  allowedServiceTypeIds: [],
  checklistNoteCategories: [],
  checklistNoteTeams: [],
};

const RUNDOWN = {
  serviceTypeId: "st1",
  planId: "p1",
  planTitle: "A plan",
  planSeriesTitle: null,
  planDates: null,
  items: [{ id: "i1", title: "Welcome", itemType: "item", lengthSec: 60, sequence: 0, notesByCategory: {}, description: null }],
  noteCategories: [],
  serviceTimes: [],
  timeZone: null,
  isActivePlan: true,
  isDefaultPlan: true,
};

/** StageView at the current address, the server answering with `state` — and every
 *  PATCH it sends recorded as [path, body]. Returns the zoom the rundown drew. */
async function driveStageView(state: unknown): Promise<{ zoom: string; patches: [string, unknown][] }> {
  const patches: [string, unknown][] = [];
  const f = stubFetchWithLog((url, init) => {
    if (init?.method === "PATCH") {
      patches.push([url, JSON.parse(String(init.body))]);
      return ok({});
    }
    if (url.includes("/api/state")) return ok(state);
    if (url.includes("/api/servicecue/layouts")) return ok([]);
    if (url.includes("/api/servicecue/roles")) return ok([]);
    if (url.includes("/api/servicecue/rundown")) return ok(RUNDOWN);
    if (url.includes("/api/pco/live")) return ok(null);
    return ok({});
  });
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(TooltipProvider, null, React.createElement(StageView)),
      ),
    );
    for (let i = 0; i < 5; i++) await settle();
    const table = document.querySelector("table");
    assert.ok(table, "the script display never drew its rundown");
    return { zoom: (table!.parentElement as HTMLElement).style.zoom, patches };
  } finally {
    f.restore();
  }
}

/** STATE with display-1's resolved descriptor carrying `textSize`. */
function stateWithSize(textSize: number | null) {
  return { ...STATE, resolvedByOutput: { "display-1": { ...STATE.resolvedByOutput["display-1"], textSize } } };
}

test("the kiosk's script display reads ?text= and keeps it on the server under its own display id", async () => {
  window.history.replaceState({}, "", "/display-1?text=150");
  const { zoom, patches } = await driveStageView(stateWithSize(null));
  assert.equal(zoom, "1.5");
  assert.deepEqual(patches, [["/api/outputs/display-1", { textSize: 150 }]]);
  assert.equal(readStoredSize(displayTextSizeKey("display-1")), null, "the device must not be where a display's size lives");
});

test("the kiosk's script display draws the size the server keeps, with no ?text=", async () => {
  window.history.replaceState({}, "", "/display-1");
  const { zoom, patches } = await driveStageView(stateWithSize(130));
  assert.equal(zoom, "1.3");
  assert.deepEqual(patches, []);
});

test("a Screens preview of that display draws the display's size, and never changes it", async () => {
  // The Screens card: /preview-<view id>?output=<display id>, in the operator's
  // browser, which remembers nothing for the display and has no ?text=.
  window.history.replaceState({}, "", "/preview-v1?output=display-1");
  const { zoom, patches } = await driveStageView(stateWithSize(200));
  assert.equal(zoom, "2", "the preview drew the rundown at 100% beside a display showing it at 200%");
  assert.deepEqual(patches, []);
});

test("a preview of a View that is not a screen draws at 100%", async () => {
  window.history.replaceState({}, "", "/preview-v1");
  const { zoom } = await driveStageView(stateWithSize(200));
  assert.equal(zoom, "", "a View's own preview took another screen's size");
});
