// Where the ServiceCue text size comes from on each screen: a display
// (servicecue-display.tsx) has no control and draws the size the SERVER keeps for
// it, keeping its `?text=` there, or a size its device remembered once; the
// standalone page starts from its address or what the browser remembered, then
// answers its A- / A+ control; a rundown embedded in a layout object has no user
// size at all. StageView's own wiring of a display and of its Screens preview is
// stage-view-script-text.test.tsx.
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
const { ServiceCue } = await import("./servicecue-view.js");
const { DisplayServiceCue } = await import("./servicecue-display.js");
const { ServiceCuePlan } = await import("./servicecue-plan-view.js");
const { TooltipProvider } = await import("../components/ui/index.js");
const { displayTextSizeKey, PAGE_TEXT_SIZE_KEY, readStoredSize } = await import("./servicecue-text-size.js");
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

/** Every PATCH /api/outputs/:id a display sent, as [id, body]. */
let patches: [string, unknown][] = [];
/** When set, a PATCH answers with this failure instead of succeeding. */
let patchFails: Error | null = null;

function stubFetch() {
  patches = [];
  patchFails = null;
  return stubFetchWithLog((url, init) => {
    if (init?.method === "PATCH") {
      patches.push([decodeURIComponent(url.split("/api/outputs/")[1] ?? url), JSON.parse(String(init.body))]);
      if (patchFails) throw patchFails;
      return ok({});
    }
    if (url.includes("/api/state")) return ok({ serviceTypeId: "st1", planId: "p1", pcoConfigured: true });
    if (url.includes("/api/service-types")) return ok([{ id: "st1", name: "Weekend" }]);
    if (url.includes("/api/servicecue/layouts")) return ok([]);
    if (url.includes("/api/servicecue/roles")) return ok([]);
    if (url.includes("/api/servicecue/rundown")) return ok(RUNDOWN);
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

/** A display as StageView renders it: the size the server keeps for it
 *  (`server`, null = none) and whether it is a Screens preview. */
function displayElement(server: number | null, isPreview = false) {
  return React.createElement(
    TooltipProvider,
    null,
    React.createElement(DisplayServiceCue, { displayId: "display-1", serviceCueLayoutId: null, serverTextSize: server, isPreview }),
  );
}

async function mountDisplay(server: number | null = null, isPreview = false): Promise<ReturnType<typeof render>> {
  const view = render(displayElement(server, isPreview));
  await settleAll();
  return view;
}

async function mountPage(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(ServiceCuePlan, { serviceTypeParam: "weekend", layoutParam: "all-columns" })),
    ),
  );
  await settleAll();
}

test("a display draws the size the server keeps for it, and writes nothing", async () => {
  const f = stubFetch();
  try {
    await mountDisplay(80);
    assert.equal(zoom(), "0.8");
    assert.deepEqual(patches, [], "a display with nothing new to keep must not write");
  } finally {
    f.restore();
  }
});

test("?text= overrides what the server holds, and is kept there", async () => {
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    await mountDisplay(80);
    assert.equal(zoom(), "1.5", "the address wins over what the server held");
    assert.deepEqual(patches, [["display-1", { textSize: 150 }]]);
  } finally {
    f.restore();
  }
});

test("?text= the server already holds is not written again", async () => {
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    await mountDisplay(150);
    assert.equal(zoom(), "1.5");
    assert.deepEqual(patches, [], "opened with the same link on every boot, it rewrote the server's size each time");
  } finally {
    f.restore();
  }
});

test("a display's size is no longer remembered in the browser, so the server is the only place it lives", async () => {
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    await mountDisplay(null);
    assert.equal(readStoredSize(DISPLAY_KEY), null);
  } finally {
    f.restore();
  }
});

test("once kept, the address is spent: a size the server later holds is the display's", async () => {
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    const view = await mountDisplay(null);
    assert.equal(zoom(), "1.5");
    // The server's broadcast arrives carrying what was kept, then something else.
    view.rerender(displayElement(150));
    await settleAll();
    view.rerender(displayElement(200));
    await settleAll();
    assert.equal(zoom(), "2", "a stale link overrode a size set some other way");
    assert.equal(patches.length, 1, "the link was written more than once");
  } finally {
    f.restore();
  }
});

test("a failed save is logged on /log, the size from the address still shows, and it is not retried in a loop", async () => {
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    patchFails = new Error("HTTP 400: textSize must be a number from 50 to 300");
    await mountDisplay(null);
    await settleAll();
    assert.equal(zoom(), "1.5");
    assert.equal(patches.length, 1, "a refused save was retried");
    assert.equal(f.logs.length, 1, JSON.stringify(f.logs));
    assert.equal(f.logs[0]?.tag, "servicecue");
    assert.match(f.logs[0]?.message ?? "", /could not keep this display's text size of 150%/);
  } finally {
    f.restore();
  }
});

test("a display the server holds nothing for hands over the size its device remembered, once", async () => {
  localStorage.setItem(DISPLAY_KEY, "80");
  const f = stubFetch();
  try {
    const view = await mountDisplay(null);
    assert.equal(zoom(), "0.8");
    assert.deepEqual(patches, [["display-1", { textSize: 80 }]]);
    // The server now holds it: the display reads that, and offers nothing more.
    view.rerender(displayElement(80));
    await settleAll();
    assert.equal(zoom(), "0.8");
    assert.equal(patches.length, 1);
    assert.equal(localStorage.getItem(DISPLAY_KEY), "80", "what the device remembered is the operator's; it is left alone");
  } finally {
    f.restore();
  }
});

test("a size remembered under the pre-rename key is handed over too", async () => {
  // The key began "scriptview-text-size:" until ServiceCue was renamed. A display
  // updated in place must not snap back to 100% on the first load after.
  const legacyKey = DISPLAY_KEY.replace("servicecue-text-size:", "scriptview-text-size:");
  assert.notEqual(legacyKey, DISPLAY_KEY, "the test's own key is not shaped as expected");
  localStorage.setItem(legacyKey, "80");
  const f = stubFetch();
  try {
    await mountDisplay(null);
    assert.equal(zoom(), "0.8", "the size remembered under the old key was ignored");
    assert.deepEqual(patches, [["display-1", { textSize: 80 }]]);
    assert.equal(localStorage.getItem(legacyKey), "80", "the old key is the operator's; it is left alone");
  } finally {
    f.restore();
  }
});

test("what the server keeps beats what the device remembered, and nothing is offered", async () => {
  localStorage.setItem(DISPLAY_KEY, "80");
  const f = stubFetch();
  try {
    await mountDisplay(120);
    assert.equal(zoom(), "1.2");
    assert.deepEqual(patches, []);
  } finally {
    f.restore();
  }
});

test("with nothing anywhere a display is not zoomed at all", async () => {
  const f = stubFetch();
  try {
    await mountDisplay(null);
    assert.equal(zoom(), "", "100% adds no style, so an untouched display renders as it always did");
    assert.deepEqual(patches, []);
  } finally {
    f.restore();
  }
});

test("a preview draws the display's kept size and neither reads the address or the device nor writes", async () => {
  localStorage.setItem(DISPLAY_KEY, "80");
  window.history.replaceState({}, "", "/preview-v1?output=display-1&text=150");
  const f = stubFetch();
  try {
    await mountDisplay(200, true);
    assert.equal(zoom(), "2");
    assert.deepEqual(patches, [], "a Screens card changed the display's size by being looked at");
  } finally {
    f.restore();
  }
});

test("a rundown embedded in a layout object ignores ?text= and anything remembered", async () => {
  localStorage.setItem(DISPLAY_KEY, "200");
  window.history.replaceState({}, "", "/display-1?text=150");
  const f = stubFetch();
  try {
    // What embedded-view.tsx passes: no size, and "" so the box sets the size.
    render(React.createElement(TooltipProvider, null, React.createElement(ServiceCue, { serviceCueLayoutId: null, textSizeClass: "" })));
    await settleAll();
    assert.equal(zoom(), "");
    assert.deepEqual(patches, []);
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

test("a size set from the page's control is written back to ?text=, so a refresh keeps it", async () => {
  window.history.replaceState({ keep: "me" }, "", "/servicecue/weekend/all-columns?plan=p9&text=150#top");
  const entries = window.history.length;
  const f = stubFetch();
  try {
    await mountPage();
    assert.equal(zoom(), "1.5");
    await act(async () => void fireEvent.click(screen.getByLabelText("Larger text")));
    assert.equal(zoom(), "1.6");
    assert.equal(
      window.location.search + window.location.hash,
      "?plan=p9&text=160#top",
      "the address still says 150, so a refresh would start from it",
    );
    assert.equal(window.history.length, entries, "a press added a history entry");
    assert.deepEqual(window.history.state, { keep: "me" }, "the history state was replaced");
    // A refresh: the page mounts again on the same address.
    cleanup();
    await mountPage();
    assert.equal(zoom(), "1.6");
  } finally {
    f.restore();
  }
});

test("the page's control does not add ?text= to an address that had none", async () => {
  window.history.replaceState({}, "", "/servicecue/weekend/all-columns?plan=p9");
  const f = stubFetch();
  try {
    await mountPage();
    await act(async () => void fireEvent.click(screen.getByLabelText("Larger text")));
    assert.equal(zoom(), "1.1");
    assert.equal(window.location.search, "?plan=p9");
  } finally {
    f.restore();
  }
});
