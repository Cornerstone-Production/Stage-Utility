// A long press on a Home card opens its menu; a drag past a few pixels does
// not — proving the composition described in home-grid.tsx's `HomeCardCell`:
// the long-press's own 8px cancel threshold and the drag's 4px start
// threshold (home-route.tsx `startDrag`) never race for the same gesture,
// because 20px of movement is well past both.
//
// `HomeCardCell` alone, not the whole `HomeGrid`: mounting `HomeGrid` needs
// the full Home data context (see card-frame-containing-block.test.tsx for
// why), and none of that context bears on whether a press opens a menu.

import assert from "node:assert/strict";
import { after, afterEach, test, describe, mock } from "node:test";

import type { LayoutObject } from "@main/types/views";
import { installDom } from "../../test-dom.js";

const teardown = installDom();
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { HomeCardCell } = await import("./home-grid.js");
const { LONG_PRESS_MS } = await import("../../components/ui/context-menu-trigger.js");
const { startCardDrag, DRAG_START_PX } = await import("./home-route.js");

const CARD: LayoutObject = {
  id: "clock-1",
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  z: 0,
  config: { type: "clock" },
} as unknown as LayoutObject;

function touchDown(el: Element, x = 10, y = 10) {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y });
}
function touchMove(el: Element, x: number, y: number) {
  fireEvent.pointerMove(el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y });
}
function touchUp(el: Element, x = 10, y = 10) {
  fireEvent.pointerUp(el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y });
}

/** See context-menu-trigger.test.tsx for why the real macrotask queue is
 *  drained here rather than only the fake clock. */
function flushReact(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("a Home card's menu on touch", () => {
  afterEach(() => cleanup());

  test("a long press opens the card's menu", async () => {
    const onMenu = mock.fn();
    const { container } = render(
      React.createElement(
        HomeCardCell as never,
        { card: CARD, w: 1, h: 1, box: undefined, onCardContextMenu: onMenu },
        React.createElement("div", null, "clock"),
      ),
    );
    const cell = container.querySelector("[data-card-id='clock-1']")!;

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      touchDown(cell, 100, 100);
      assert.equal(onMenu.mock.callCount(), 0, "must not open before the hold completes");
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onMenu.mock.callCount(), 1, "a completed long press must open the card's menu");
      assert.equal(onMenu.mock.calls[0].arguments[0], CARD);
      assert.deepEqual(onMenu.mock.calls[0].arguments[1], { x: 100, y: 100 });
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });

  test("a 20px drag does not open the menu", async () => {
    const onMenu = mock.fn();
    const { container } = render(
      React.createElement(
        HomeCardCell as never,
        { card: CARD, w: 1, h: 1, box: undefined, onCardContextMenu: onMenu },
        React.createElement("div", null, "clock"),
      ),
    );
    const cell = container.querySelector("[data-card-id='clock-1']")!;

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      touchDown(cell, 100, 100);
      // 20px, well past the hook's own cancel threshold AND home-route's
      // 4px drag-start threshold — a real drag would already be under way by
      // the time a finger has moved this far.
      touchMove(cell, 120, 100);
      touchUp(cell, 120, 100);
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onMenu.mock.callCount(), 0, "movement past the cancel threshold must not open the menu");
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });

  /**
   * A drag handle wired to the REAL `startCardDrag` from home-route.tsx — the
   * same function `HomeRoute`'s editing chrome calls, not a copy of its
   * movement-threshold logic. `HomeCardCell`'s new `chrome` prop is what gives
   * a caller access to this cell's own `cancel()` (see home-grid.tsx), which
   * is exactly what a drag starting on this handle is expected to call.
   */
  function renderCardWithDragHandle(onMenu: (...args: unknown[]) => void, onDragStart: () => void) {
    const chrome = (card: LayoutObject, cancelPress: () => void) =>
      React.createElement("div", {
        "data-testid": "drag-handle",
        style: { position: "absolute", inset: 0 },
        onPointerDown: (e: React.PointerEvent<HTMLElement>) =>
          startCardDrag(
            e,
            card.id,
            { cellAt: () => null, onDragStart, onDropCell: () => {}, onDrop: () => {}, onEnd: () => {} },
            cancelPress,
          ),
      });
    return render(
      React.createElement(
        HomeCardCell as never,
        { card: CARD, w: 1, h: 1, box: undefined, onCardContextMenu: onMenu, chrome },
        React.createElement("div", null, "clock"),
      ),
    );
  }

  test("a 5px move then a 500ms hold does not open the menu mid-drag", async () => {
    // CRITICAL, reproduced before the fix: the long-press hook cancelled at
    // 8px while home-route's drag started at 4px, so a finger moving 5-7px
    // and then holding still cleared neither threshold in time — the drag was
    // already under way and the long-press timer was STILL RUNNING, opening
    // the menu on top of a live drag 500ms later.
    const onMenu = mock.fn();
    const onDragStart = mock.fn();
    const { container } = renderCardWithDragHandle(onMenu, onDragStart);
    const handle = container.querySelector("[data-testid='drag-handle']") as HTMLElement & {
      setPointerCapture: (id: number) => void;
      hasPointerCapture: (id: number) => boolean;
      releasePointerCapture: (id: number) => void;
    };
    // jsdom implements none of the Pointer Capture methods `startCardDrag`
    // calls once a drag actually starts — stubbed the same way
    // drawer-drag-lifecycle.test.tsx does for the same reason.
    handle.setPointerCapture = () => {};
    handle.hasPointerCapture = () => false;
    handle.releasePointerCapture = () => {};

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      touchDown(handle, 100, 100);
      touchMove(handle, 105, 100);
      assert.equal(onDragStart.mock.callCount(), 1, "5px must be enough to start the real drag");
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onMenu.mock.callCount(), 0, "a live drag must suppress the long-press menu");
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });

  test("a move of exactly the drag's own start distance still cancels the long press", async () => {
    // The hook's cancel threshold now MATCHES the drag's start distance
    // (both 4px — see HomeCardCell), so a move that just barely starts the
    // drag (>= 4px) does not necessarily exceed the hook's own cancel check
    // (> 4px, false at exactly 4px). Only `startCardDrag`'s explicit call to
    // `cancelPress()` catches this boundary — proof: commenting out
    // `cancelPress?.()` in home-route.tsx's `startCardDrag` and rerunning
    // this test makes `onMenu` fire, because 4px alone never trips the
    // hook's own `> cancelPx` check.
    const onMenu = mock.fn();
    const onDragStart = mock.fn();
    const { container } = renderCardWithDragHandle(onMenu, onDragStart);
    const handle = container.querySelector("[data-testid='drag-handle']") as HTMLElement & {
      setPointerCapture: (id: number) => void;
      hasPointerCapture: (id: number) => boolean;
      releasePointerCapture: (id: number) => void;
    };
    handle.setPointerCapture = () => {};
    handle.hasPointerCapture = () => false;
    handle.releasePointerCapture = () => {};

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      touchDown(handle, 100, 100);
      touchMove(handle, 100 + DRAG_START_PX, 100);
      assert.equal(onDragStart.mock.callCount(), 1, "the drag's own threshold must have started it");
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onMenu.mock.callCount(), 0, "the explicit cancel() must have stopped the long press");
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });

  test("a 500ms hold on a nested control does not open the menu", async () => {
    // CRITICAL, reproduced before the fix: the hook had no equivalent of the
    // drag's own guard against pressing a CONTROL, so a hold on a card's
    // inner button (a Switch, anything with its own press behaviour) opened
    // the menu on top of it.
    const onMenu = mock.fn();
    const { container } = render(
      React.createElement(
        HomeCardCell as never,
        { card: CARD, w: 1, h: 1, box: undefined, onCardContextMenu: onMenu },
        React.createElement("button", { type: "button" }, "toggle"),
      ),
    );
    const cell = container.querySelector("[data-card-id='clock-1']")!;
    const innerButton = container.querySelector("button")!;

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      fireEvent.pointerDown(innerButton, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onMenu.mock.callCount(), 0, "a hold on an inner control must not open the card's menu");

      // The plain card body still opens the menu — the guard is scoped to
      // controls, not the whole card.
      touchDown(cell, 100, 100);
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onMenu.mock.callCount(), 1, "a hold on the card body must still open the menu");
      // Unmounted here, inside the SAME fake-timer window the two presses
      // above ran in — two `setPressing` renders (one per touchDown) left
      // React's own scheduling still pending after the usual single
      // `flushReact()` drain if the unmount happened only in `afterEach`,
      // outside the fake timers and after this test had already returned.
      cleanup();
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });
});

after(() => teardown());
