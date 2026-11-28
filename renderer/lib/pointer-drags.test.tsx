// The Home card drag and the panel-width drag go through bindGesture, so a second
// finger cannot steer them and a release that lands off the element still ends them.
// They used to bind pointermove/pointerup on the element with no pointerId check.
import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { startCardDrag, DRAG_START_PX } = await import("../app/home/home-route.js");
const { usePanelWidth } = await import("./use-sidebar-width.js");

afterEach(() => {
  cleanup();
  localStorage.clear();
});
after(() => unmountAndTeardown(cleanup, teardown));

function stubCapture(el: HTMLElement) {
  const held = new Set<number>();
  Object.assign(el, {
    setPointerCapture: (id: number) => held.add(id),
    hasPointerCapture: (id: number) => held.has(id),
    releasePointerCapture: (id: number) => held.delete(id),
  });
}
const ptr = (pointerId: number, x: number, y = 0) => ({ pointerId, pointerType: "mouse", button: 0, clientX: x, clientY: y });

describe("the Home card drag", () => {
  function handle(calls: { start: number; end: number; drop: number }) {
    const view = render(
      React.createElement("div", {
        "data-testid": "h",
        onPointerDown: (e: React.PointerEvent<HTMLElement>) =>
          startCardDrag(e, "card", {
            cellAt: () => null,
            onDragStart: () => { calls.start++; },
            onDropCell: () => {},
            onDrop: () => { calls.drop++; },
            onEnd: () => { calls.end++; },
          }),
      }),
    );
    const el = view.getByTestId("h");
    stubCapture(el);
    return el;
  }

  test("a second pointer's moves do not start the drag", () => {
    const calls = { start: 0, end: 0, drop: 0 };
    const el = handle(calls);
    fireEvent.pointerDown(el, ptr(1, 100));
    fireEvent.pointerMove(el, ptr(2, 100 + DRAG_START_PX * 5));
    assert.equal(calls.start, 0, "another pointer's move started this pointer's drag");
  });

  test("a release off the element still ends the drag", () => {
    const calls = { start: 0, end: 0, drop: 0 };
    const el = handle(calls);
    fireEvent.pointerDown(el, ptr(1, 100));
    // Released outside the element: the pointerup never reaches it.
    fireEvent.pointerUp(document.body, ptr(1, 100));
    assert.equal(calls.end, 1, "the drag never ended");
    fireEvent.pointerMove(el, ptr(1, 100 + DRAG_START_PX * 5));
    assert.equal(calls.start, 0, "a later hover with no button held started a drag");
  });

  test("a cancelled pointer ends it without dropping", () => {
    const calls = { start: 0, end: 0, drop: 0 };
    const el = handle(calls);
    fireEvent.pointerDown(el, ptr(1, 100));
    fireEvent.pointerMove(el, ptr(1, 100 + DRAG_START_PX * 5));
    fireEvent.pointerCancel(el, ptr(1, 100));
    assert.deepEqual(calls, { start: 1, end: 1, drop: 0 });
  });
});

describe("the panel-width drag", () => {
  function Harness({ onWidth }: { onWidth: (w: number) => void }) {
    const w = usePanelWidth({ storageKey: "test-panel-width", defaultWidth: 300, min: 100, max: 600 });
    onWidth(w.width);
    return React.createElement("div", { "data-testid": "h", onPointerDown: w.startResize });
  }

  test("a second pointer's moves and release do not steer the width", async () => {
    let width = 0;
    const view = render(React.createElement(Harness, { onWidth: (w: number) => { width = w; } }));
    const el = view.getByTestId("h");
    stubCapture(el);
    await act(async () => {
      fireEvent.pointerDown(el, ptr(1, 100));
      fireEvent.pointerDown(el, ptr(2, 100));
      fireEvent.pointerMove(el, ptr(2, 200));
      fireEvent.pointerUp(el, ptr(1, 100));
    });
    assert.equal(width, 300, "another pointer's move resized the panel");
  });

  test("a drag still under way when the panel goes away leaves nothing bound", async () => {
    const view = render(React.createElement(Harness, { onWidth: () => {} }));
    const el = view.getByTestId("h");
    stubCapture(el);
    await act(async () => {
      fireEvent.pointerDown(el, ptr(1, 100));
      fireEvent.pointerMove(el, ptr(1, 150));
    });
    view.unmount();
    fireEvent.pointerUp(document.body, ptr(1, 150));
    assert.equal(localStorage.getItem("test-panel-width"), null, "the dead drag still saved a width");
  });

  test("the owning pointer still resizes it", async () => {
    let width = 0;
    const view = render(React.createElement(Harness, { onWidth: (w: number) => { width = w; } }));
    const el = view.getByTestId("h");
    stubCapture(el);
    await act(async () => {
      fireEvent.pointerDown(el, ptr(1, 100));
      fireEvent.pointerMove(el, ptr(1, 150));
      fireEvent.pointerUp(el, ptr(1, 150));
    });
    assert.equal(width, 350);
  });
});
