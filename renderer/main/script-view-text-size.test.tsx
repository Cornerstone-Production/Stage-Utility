// Where the ServiceCue text size comes from on each screen: the display View
// kind (script-view.tsx) has no control, so its size is the address's `?text=`,
// else what that display remembered; the standalone page starts the same way and
// then answers its A- / A+ control; a rundown embedded in a layout object has no
// user size at all.
//
// Driven through the real components. The size reaches the rundown as a CSS
// `zoom` on the element inside its measured wrapper (rundown-table.tsx); that
// inline style is what is asserted. NOT asserted, because jsdom loads no
// stylesheet and does no layout: that the text is visibly bigger and the header
// is not. Driven in a browser instead. NOTHING BELOW PASSES A DOM NODE AS AN
// ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, test } from "node:test";

import { FakeEventSource } from "../test-fixtures/fake-event-source.js";
import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ScriptView } = await import("./script-view.js");
const { ScriptViewPlan } = await import("./scriptview-plan-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { displayTextSizeKey, PAGE_TEXT_SIZE_KEY, readStoredSize } = await import("./scriptview-text-size.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));

const DISPLAY_KEY = displayTextSizeKey("display-1");

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const RUNDOWN = {
  serviceTypeId: "st1",
  planId: "p1",
  planTitle: "Sunday service",
  planSeriesTitle: null,
  planDates: null,
  items: [{ id: "i1", title: "Welcome", itemType: "item", lengthSec: 60, sequence: 0, notesByCategory: {}, description: null }],
  noteCategories: [],
  serviceTimes: [],
  timeZone: null,
  isActivePlan: false,
  isDefaultPlan: true,
};

function stubFetch() {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/state")) return ok({ serviceTypeId: "st1", planId: "p1", pcoConfigured: true });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/scriptview/layouts")) return ok([]);
    if (url.includes("/api/scriptview/roles")) return ok([]);
    if (url.includes("/api/scriptview/rundown")) return ok(RUNDOWN);
    if (url.includes("/api/plans/upcoming")) return ok({ plans: [], cacheAgeMs: 0 });
    if (url.includes("/api/pco/live")) return ok(null);
    return ok({});
  });
}

/** The zoom the rundown was given, or "" when it has none. The table's parent is
 *  the element RundownTable zooms. */
function zoom(): string {
  const table = document.querySelector("table");
  assert.ok(table, "the rundown never rendered");
  return (table!.parentElement as HTMLElement).style.zoom ?? "";
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 4; i++) await settle();
}

async function mountDisplay(props: Record<string, unknown> = { textSizeKey: DISPLAY_KEY }): Promise<void> {
  render(React.createElement(TooltipProvider, null, React.createElement(ScriptView, { scriptViewLayoutId: null, ...props })));
  await settleAll();
}

async function mountPage(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(ScriptViewPlan, { serviceTypeParam: "weekend", layoutParam: "all-columns" })),
    ),
  );
  await settleAll();
}

test("?text= overrides the stored size on the display view", async () => {
  localStorage.setItem(DISPLAY_KEY, "80");
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    await mountDisplay();
    assert.equal(zoom(), "1.5", "the address wins over what the display remembered");
  } finally {
    f.restore();
  }
});

test("the display remembers the size from its address, so the link only has to be opened once", async () => {
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    await mountDisplay();
    assert.equal(readStoredSize(DISPLAY_KEY), 150);
    cleanup();
    window.history.replaceState({}, "", "/display-1");
    await mountDisplay();
    assert.equal(zoom(), "1.5", "opened again with no ?text=, it keeps the size");
  } finally {
    f.restore();
  }
});

test("with no ?text= the display shows what it remembered, and with neither it is not zoomed at all", async () => {
  const f = stubFetch();
  try {
    localStorage.setItem(DISPLAY_KEY, "80");
    await mountDisplay();
    assert.equal(zoom(), "0.8");
    cleanup();
    localStorage.clear();
    await mountDisplay();
    assert.equal(zoom(), "", "100% adds no style, so an untouched display renders as it always did");
  } finally {
    f.restore();
  }
});

test("a rundown embedded in a layout object ignores ?text= and anything remembered", async () => {
  localStorage.setItem(DISPLAY_KEY, "200");
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    // What embedded-view.tsx passes: no key, and "" so the box sets the size.
    await mountDisplay({ textSizeClass: "" });
    assert.equal(zoom(), "");
  } finally {
    f.restore();
  }
});

test("the page and a display keep separate sizes", async () => {
  localStorage.setItem(DISPLAY_KEY, "80");
  const f = stubFetch();
  try {
    await mountPage();
    assert.equal(zoom(), "", "the page does not read the display's size");
    await act(async () => void fireEvent.click(screen.getByLabelText("Larger text")));
    assert.equal(zoom(), "1.1");
    assert.equal(readStoredSize(PAGE_TEXT_SIZE_KEY), 110, "the page remembers its own");
    assert.equal(readStoredSize(DISPLAY_KEY), 80, "and the display's is untouched");
  } finally {
    f.restore();
  }
});

test("the page also starts from ?text=, and its control moves on from there", async () => {
  window.history.replaceState({}, "", "/servicecue/weekend/all-columns?text=200");
  const f = stubFetch();
  try {
    await mountPage();
    assert.equal(zoom(), "2");
    await act(async () => void fireEvent.click(screen.getByLabelText("Smaller text")));
    assert.equal(zoom(), "1.9");
  } finally {
    f.restore();
  }
});
