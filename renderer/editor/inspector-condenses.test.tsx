// The inspector has to fit the width it can be dragged to.
//
// It could be dragged to 260px and its contents did not fit even there: the tint
// swatches overflowed by 26px and the alignment buttons by 16px, so the panel
// scrolled sideways and the labels went off the left edge. Reported as clipping
// that forced horizontal scrolling.
//
// The fit itself is measured in a REAL browser — jsdom has no layout engine and
// no container queries, so every overflow assertion passes there whatever the
// CSS says (see "Checking object types at extreme sizes" in
// docs/reference/layout-editor.md). At 176px, seven object types measured 0px of
// horizontal scroll and nothing past the panel's right edge.
//
// What is worth pinning here is the two things that made that possible and are
// easy to delete by accident: the row's stacking, and the floor it was lowered
// to.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { MIN_INSPECTOR_WIDTH, MIN_SIDEBAR_WIDTH } from "../lib/use-sidebar-width.js";
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { Row } = await import("./inspector-rows.js");

after(() => {
  cleanup();
  teardown();
});

describe("how narrow the inspector goes", () => {
  test("as narrow as the rail beside it, which is what was asked for", () => {
    assert.equal(MIN_INSPECTOR_WIDTH, MIN_SIDEBAR_WIDTH);
  });
});

describe("a row at that width", () => {
  test("stacks its label above its control, and lets the control wrap", () => {
    // A 96px label in a 176px panel leaves 64px, which is narrower than a
    // stepper field. Class-level rather than measured, because the query this
    // depends on does not exist in jsdom — deleting either variant is the
    // regression, and this is what notices.
    const { container } = render(
      React.createElement(Row as never, { label: "Radius", children: React.createElement("input") }),
    );
    const row = container.firstElementChild as HTMLElement;
    assert.match(row.className, /@max-\[\d+px\]\/insp:flex-col/, "the row no longer stacks when narrow");
    const control = row.lastElementChild as HTMLElement;
    assert.match(control.className, /@max-\[\d+px\]\/insp:flex-wrap/, "the control no longer wraps when narrow");
    // And it is still a side-by-side row at a normal width.
    assert.match(row.className, /^flex items-center/);
  });
});
