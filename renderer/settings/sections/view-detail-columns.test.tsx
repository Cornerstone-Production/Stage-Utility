// view-detail-columns.test.tsx — a Script view's Columns picker, when the
// column sets fail to load.
//
// The read used to `.catch(() => setScriptViewLayouts([]))`. The picker then
// offered only "All columns", and labelled the view's own saved set
// "· not found", which says it was deleted. It was not; the read failed. The
// failure path now shows the failure in the picker's place, so there is also
// nothing to switch to All columns by accident.
//
// Driven through the real component with a stubbed fetch. NOTHING BELOW PASSES
// A DOM NODE AS AN ASSERT OPERAND — node:assert inspects `actual` to build its
// failure message, and inspecting a live jsdom element does not finish in any
// useful time. Every query is coerced to a boolean or a string first.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { alerts, ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { ViewDetail } = await import("./view-detail.js");
const { TooltipProvider } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const VIEW = {
  id: "v1",
  name: "Booth script",
  kind: "script",
  createdAt: "2026-01-01T00:00:00.000Z",
  scriptViewLayoutId: "svl-audio",
} as View;

/** Only what the script branch reads; everything else is inert here. */
function props(kind: ViewKind = "script"): Parameters<typeof ViewDetail>[0] {
  return {
    view: { ...VIEW, kind },
    canDelete: true,
    stageState: { views: [VIEW], outputs: [] },
    wirelessChannels: [],
    teamPositions: [],
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

function stubFetch(fail: boolean) {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/scriptview/layouts")) {
      if (fail) throw new TypeError("fetch failed");
      return ok([{ id: "svl-audio", name: "Audio", order: 0 }]);
    }
    return ok({});
  });
}

async function mount(): Promise<void> {
  // The operator app wraps everything in a TooltipProvider (renderer/app/index.tsx).
  render(React.createElement(TooltipProvider, null, React.createElement(ViewDetail, props())));
  await settle();
  await settle();
}

test("a failed column-set read says so in the picker's place, and reaches the log", async () => {
  const f = stubFetch(true);
  try {
    await mount();
    assert.match(alerts(), /Couldn't load the saved column sets/i);
    assert.equal(
      !!screen.queryByRole("combobox", { name: "Columns" }),
      false,
      "no picker to switch to All columns while the list is missing",
    );
    assert.equal(!!screen.queryByText(/not found/i), false, "the view's column set was not deleted — the read failed");
    assert.ok(
      f.logs.some((l) => l.tag === "scriptview" && /column sets/i.test(l.message)),
      `expected a [scriptview] line naming the column sets — got ${JSON.stringify(f.logs)}`,
    );
  } finally {
    f.restore();
  }
});

test("a slow failure from before a kind change does not replace the picker", async () => {
  // Script, then Stage, then Script again: the first read is still out, and
  // fails only after the second one has filled the picker.
  let failFirst: (e: Error) => void = () => {};
  let reads = 0;
  const f = stubFetchWithLog((url) => {
    if (!url.includes("/api/scriptview/layouts")) return ok({});
    reads += 1;
    if (reads === 1) return new Promise((_, reject) => { failFirst = reject; });
    return ok([{ id: "svl-audio", name: "Audio", order: 0 }]);
  });
  try {
    const el = (kind: ViewKind) => React.createElement(TooltipProvider, null, React.createElement(ViewDetail, props(kind)));
    const view = render(el("script"));
    await settle();
    view.rerender(el("stage"));
    await settle();
    view.rerender(el("script"));
    await settle();
    await settle();
    assert.equal(!!screen.queryByRole("option", { name: "Audio" }), true, "the second read filled the picker");
    await act(async () => failFirst(new TypeError("fetch failed")));
    await settle();
    assert.equal(alerts(), "", "the first read no longer applies; its failure must not land");
    assert.equal(!!screen.queryByRole("combobox", { name: "Columns" }), true);
  } finally {
    f.restore();
  }
});

test("a read that works after a failed one brings the picker back", async () => {
  // Script fails; Stage, then Script again, reads the column sets.
  let reads = 0;
  const f = stubFetchWithLog((url) => {
    if (!url.includes("/api/scriptview/layouts")) return ok({});
    reads += 1;
    if (reads === 1) throw new TypeError("fetch failed");
    return ok([{ id: "svl-audio", name: "Audio", order: 0 }]);
  });
  try {
    const el = (kind: ViewKind) => React.createElement(TooltipProvider, null, React.createElement(ViewDetail, props(kind)));
    const view = render(el("script"));
    await settle();
    await settle();
    assert.match(alerts(), /Couldn't load the saved column sets/i);
    view.rerender(el("stage"));
    await settle();
    view.rerender(el("script"));
    await settle();
    await settle();
    assert.equal(alerts(), "", "the column sets loaded; the note must go with the failure");
    assert.equal(!!screen.queryByRole("combobox", { name: "Columns" }), true);
  } finally {
    f.restore();
  }
});

test("control: the column sets load, the picker offers them, nothing alerts", async () => {
  const f = stubFetch(false);
  try {
    await mount();
    assert.equal(!!screen.queryByRole("combobox", { name: "Columns" }), true);
    assert.equal(!!screen.queryByRole("option", { name: "Audio" }), true);
    assert.equal(alerts(), "");
    assert.deepEqual(f.logs, []);
  } finally {
    f.restore();
  }
});
