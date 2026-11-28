// A touch drag from a palette tile, and the click that may or may not follow it.
//
// A finger drag ends with a click on the tile, which must not add the widget a second
// time. A drag the system cancels is followed by NO click, and a keyboard activation
// (Enter on the focused tile) is a click with detail 0: neither may be swallowed by a
// flag the drag left behind. use-press-drag.ts has the same rule.
import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { Palette } = await import("./palette.js");
const { PALETTE_GROUPS } = await import("../main/layout-objects.js");

afterEach(() => cleanup());
after(() => unmountAndTeardown(cleanup, teardown));

const ALL_TYPES = PALETTE_GROUPS.flatMap((g) => g.types);
const noop = () => {};

function mount() {
  const added: string[] = [];
  const view = render(
    React.createElement(Palette as never, {
      types: ALL_TYPES,
      onAdd: (t: string) => added.push(t),
      onDragStart: noop,
      onDragEnd: noop,
      onDropAt: noop,
    }),
  );
  const tile = view.container.querySelector("button[draggable]") as HTMLElement;
  return { added, tile };
}
const touch = (id = 1) => ({ pointerId: id, pointerType: "touch", isPrimary: true, button: 0 });

describe("a palette tile after a touch drag", () => {
  test("a drag the system cancels leaves Enter on the tile adding the widget", () => {
    const { added, tile } = mount();
    fireEvent.pointerDown(tile, { ...touch(), clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile, { ...touch(), clientX: 60, clientY: 10 });
    fireEvent.pointerCancel(tile, { ...touch(), clientX: 60, clientY: 10 });
    fireEvent.click(tile, { detail: 0 });
    assert.equal(added.length, 1, "Enter on the tile was swallowed after a cancelled drag");
  });

  test("the click that trails a finger drop is still swallowed", () => {
    const { added, tile } = mount();
    fireEvent.pointerDown(tile, { ...touch(), clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile, { ...touch(), clientX: 60, clientY: 10 });
    fireEvent.pointerUp(tile, { ...touch(), clientX: 60, clientY: 10 });
    fireEvent.click(tile, { detail: 1 });
    assert.equal(added.length, 0, "the drop was added a second time by its trailing click");
  });

  test("Enter after a drop whose click never reached the tile still adds", () => {
    const { added, tile } = mount();
    fireEvent.pointerDown(tile, { ...touch(), clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile, { ...touch(), clientX: 60, clientY: 10 });
    fireEvent.pointerUp(tile, { ...touch(), clientX: 60, clientY: 10 });
    fireEvent.click(tile, { detail: 0 });
    assert.equal(added.length, 1, "a keyboard click was taken for the drag's trailing click");
  });

  test("a plain tap adds", () => {
    const { added, tile } = mount();
    fireEvent.pointerDown(tile, { ...touch(), clientX: 10, clientY: 10 });
    fireEvent.pointerUp(tile, { ...touch(), clientX: 10, clientY: 10 });
    fireEvent.click(tile, { detail: 1 });
    assert.equal(added.length, 1);
  });
});
