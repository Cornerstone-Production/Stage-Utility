// The widget palette, rendered — not asserted over PALETTE_GROUPS alone.
//
// layout-objects.test.ts pins the registry (cue-button's group and placement); what
// that test cannot see is whether the PALETTE COMPONENT draws exactly one tile for
// the Button and what adding it makes. A spec with a group is not the same guarantee as a tile an
// operator can click or drag — that gap is how "custom layouts with buttons to
// advance and go back through the baptisms" once had nowhere in the UI to add one.
//
// The palette offers ONE Button. It adds a cue-button, which starts with nothing
// chosen: an unbound cue-button is the one that tells the operator what to do next,
// and the inspector's Presses control is where it is chosen.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
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

const BUTTON_TILES = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].filter((b) => b.querySelector("span.font-medium")?.textContent === "Button");

describe("the widget palette", () => {
  test("offers exactly one Button tile, in Control, and neither old name", () => {
    const { container, queryByText } = render(
      React.createElement(Palette as never, {
        types: ALL_TYPES,
        onAdd: noop,
        onDragStart: noop,
        onDragEnd: noop,
      }),
    );
    const tiles = BUTTON_TILES(container);
    assert.equal(tiles.length, 1, `expected one Button tile, found ${tiles.length}`);
    assert.ok(container.textContent?.includes("Control"), "the Control group heading should be present");
    assert.equal(queryByText("Action button"), null, "Action button must not be a tile of its own");
    assert.equal(queryByText("Cue button"), null, "Cue button must not be a tile of its own");
  });

  test("clicking the tile adds a cue-button", () => {
    const added: string[] = [];
    const { container } = render(
      React.createElement(Palette as never, {
        types: ALL_TYPES,
        onAdd: (t: string) => added.push(t),
        onDragStart: noop,
        onDragEnd: noop,
      }),
    );
    BUTTON_TILES(container)[0]!.click();
    assert.deepEqual(added, ["cue-button"]);
  });

  test("searching for either old name still finds the Button", () => {
    // The blurb names both halves, so "action" and "cue" each land on it.
    const { container, getByLabelText } = render(
      React.createElement(Palette as never, {
        types: ALL_TYPES,
        onAdd: noop,
        onDragStart: noop,
        onDragEnd: noop,
      }),
    );
    for (const q of ["action", "cue"]) {
      fireEvent.change(getByLabelText("Search widgets"), { target: { value: q } });
      assert.equal(BUTTON_TILES(container).length, 1, `searching "${q}" should find the Button`);
    }
  });
});
