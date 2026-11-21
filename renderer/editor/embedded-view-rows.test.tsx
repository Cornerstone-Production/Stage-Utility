// embedded-view-rows.test.tsx — the Embedded view object's inspector rows (design review
// finding 2, and the layout line of finding 1).
//
// The picker used to read "Audio tablet (script)", offered the view being edited as
// something to embed in itself (refused only at render), and showed "Show the view's
// header" and "Follow the live item" for every kind though both act only on a ServiceCue
// view. Rendered, not read off the source: the inspector proper needs a stack of live
// integration hooks to mount, so the rows are their own component.
//
// NOT unit-tested here, and driven in a browser instead: how the rows sit in the
// inspector's column at its dragged widths, and that Change lands on the view's Layout
// select flashed (the router and the flash outline need the real app).
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { EmbeddedViewRows } = await import("./embedded-view-rows.js");
const { TooltipProvider } = await import("../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const VIEWS = [
  { id: "stage-left", name: "Stage left", kind: "script", serviceCueLayoutId: "l-band" },
  { id: "everything", name: "Everything", kind: "script", serviceCueLayoutId: null },
  { id: "mic-wall", name: "Mic wall", kind: "slots" },
  { id: "overview", name: "Stage overview", kind: "custom" },
  { id: "home", name: "Home", kind: "custom" },
] as unknown as Parameters<typeof EmbeddedViewRows>[0]["views"];

type Config = Parameters<typeof EmbeddedViewRows>[0]["c"];

function stubLayouts(fail = false) {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/servicecue/layouts")) {
      if (fail) throw new TypeError("fetch failed");
      return ok([{ id: "l-band", name: "Band", order: 0 }]);
    }
    return ok({});
  });
}

function mount(c: Config, onConfig: (c: Config) => void = () => {}) {
  render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(EmbeddedViewRows, { c, onConfig: onConfig as never, hostViewId: "overview", views: VIEWS }),
    ),
  );
}
const picker = () => screen.getByRole("combobox", { name: "View" });
const optionTexts = () => [...picker().querySelectorAll("option")].map((o) => o.textContent);
const has = (name: string) => !!screen.queryByRole("switch", { name });

test("the picker names each kind as New view does, and leaves the view being edited out", async () => {
  const f = stubLayouts();
  try {
    mount({ type: "view-embed", viewId: null });
    await settle();
    assert.deepEqual(optionTexts(), ["None", "Stage left (ServiceCue)", "Everything (ServiceCue)", "Mic wall (Mic Slots)", "Home (Custom Layout)"]);
  } finally {
    f.restore();
  }
});

test("the header and follow switches appear only for a ServiceCue view", async () => {
  const f = stubLayouts();
  try {
    mount({ type: "view-embed", viewId: "mic-wall", showHeader: true, autoScroll: false });
    await settle();
    assert.equal(has("Show the view's header"), false);
    assert.equal(has("Follow the live item"), false);
    cleanup();
    mount({ type: "view-embed", viewId: null });
    await settle();
    assert.equal(has("Follow the live item"), false, "nothing picked, nothing to follow");
    cleanup();
    mount({ type: "view-embed", viewId: "stage-left" });
    await settle();
    assert.equal(has("Show the view's header"), true);
    assert.equal(has("Follow the live item"), true);
  } finally {
    f.restore();
  }
});

test("saved header and follow values survive a pick of another kind and back", async () => {
  const f = stubLayouts();
  try {
    const seen: Config[] = [];
    mount({ type: "view-embed", viewId: "stage-left", showHeader: true, autoScroll: false }, (c) => seen.push(c));
    await settle();
    fireEvent.change(picker(), { target: { value: "mic-wall" } });
    assert.deepEqual(seen, [{ type: "view-embed", viewId: "mic-wall", showHeader: true, autoScroll: false }]);
  } finally {
    f.restore();
  }
});

test("a ServiceCue view's layout is named under the picker, with Change to its edit page", async () => {
  const f = stubLayouts();
  try {
    mount({ type: "view-embed", viewId: "stage-left" });
    await eventually(() => assert.match(document.body.textContent ?? "", /Shows the Band layout/));
    assert.equal(screen.getByRole("link", { name: "Change" }).getAttribute("href"), "/screens/stage-left/edit");
    cleanup();
    mount({ type: "view-embed", viewId: "everything" });
    await eventually(() => assert.match(document.body.textContent ?? "", /Shows All columns/));
    assert.equal(screen.getByRole("link", { name: "Change" }).getAttribute("href"), "/screens/everything/edit");
    cleanup();
    mount({ type: "view-embed", viewId: "mic-wall" });
    await settle();
    assert.equal(!!screen.queryByRole("link", { name: "Change" }), false, "only a ServiceCue view has a layout to change");
  } finally {
    f.restore();
  }
});

test("layouts that cannot be read say so and reach the log, and Change is still there", async () => {
  const f = stubLayouts(true);
  try {
    mount({ type: "view-embed", viewId: "stage-left" });
    await eventually(() => assert.match(document.body.textContent ?? "", /Couldn't read this view's layout/));
    assert.equal(!!screen.queryByRole("link", { name: "Change" }), true);
    await eventually(() => assert.ok(f.logs.some((l) => l.tag === "layout-editor" && /ServiceCue layouts/.test(l.message)), JSON.stringify(f.logs)));
  } finally {
    f.restore();
  }
});
