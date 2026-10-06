// The kiosk's script display takes its text size from `?text=`.
//
// script-view-text-size.test.tsx drives ServiceCue with a key handed to it. This
// is the other half: that StageView, the thing a Pi actually opens at /display-1,
// hands the script display its OWN key. Without it the display view would
// quietly ignore `?text=` — the display has no control to notice that on.
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
const { displayTextSizeKey, readStoredSize } = await import("./scriptview-text-size.js");
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

test("the kiosk's script display reads ?text= and remembers it under its own display id", async () => {
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok(STATE);
    if (url.includes("/api/scriptview/layouts")) return ok([]);
    if (url.includes("/api/scriptview/roles")) return ok([]);
    if (url.includes("/api/scriptview/rundown")) return ok(RUNDOWN);
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
    assert.equal((table!.parentElement as HTMLElement).style.zoom, "1.5");
    assert.equal(readStoredSize(displayTextSizeKey("display-1")), 150, "stored under the display's own id");
  } finally {
    f.restore();
  }
});
