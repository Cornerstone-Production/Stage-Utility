// The widget palette, rendered — not asserted over PALETTE_GROUPS alone.
//
// layout-objects.test.ts already pins action-button's placement in the
// registry (group "Control", directly after rosstalk-button); what that test
// cannot see is whether the PALETTE COMPONENT actually draws a tile for it —
// a spec entry with a group is not the same guarantee as a tile an operator
// can click or drag. That gap is exactly how a maintainer's "custom layouts
// with buttons to advance and go back through the baptisms" ask went unmet:
// the object existed, ran when placed, and had nowhere in the UI to add one.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { Palette } = await import("./palette.js");
const { PALETTE_GROUPS } = await import("../main/layout-objects.js");

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());

const ALL_TYPES = PALETTE_GROUPS.flatMap((g) => g.types);
const noop = () => {};

describe("the widget palette", () => {
  test("offers a clickable Action button tile, in Control", () => {
    const { container, getByText } = render(
      React.createElement(Palette as never, {
        types: ALL_TYPES,
        onAdd: noop,
        onDragStart: noop,
        onDragEnd: noop,
      }),
    );
    const tile = getByText("Action button").closest("button");
    assert.ok(tile, "no clickable tile for Action button");
    assert.ok(container.textContent?.includes("Control"), "the Control group heading should be present");
  });

  test("clicking the tile adds it", () => {
    const added: string[] = [];
    const { getByText } = render(
      React.createElement(Palette as never, {
        types: ALL_TYPES,
        onAdd: (t: string) => added.push(t),
        onDragStart: noop,
        onDragEnd: noop,
      }),
    );
    getByText("Action button").closest("button")!.click();
    assert.deepEqual(added, ["action-button"]);
  });
});
