import assert from "node:assert/strict";
import { after, afterEach, test, describe, mock } from "node:test";

import { installDom } from "../../test-dom.js";

// installDom() first, then the DOM-dependent modules by dynamic import — same
// order context-menu.test.tsx uses, and for the same reason: a static import of
// React/testing-library would evaluate before the DOM exists.
const teardown = installDom();
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { useContextMenuTrigger, LONG_PRESS_MS, MOVE_CANCEL_PX } = await import("./context-menu-trigger.js");

/** A minimal trigger element — everything real callers spread onto their own
 *  node, wired onto a plain `<div>` with a data attribute to find it by. */
function Trigger({ onOpen }: { onOpen: (p: { x: number; y: number }) => void }) {
  // `cancel` is not a DOM attribute — it is the caller-facing escape hatch a
  // COMPETING gesture (Home's card drag) uses, and no real trigger spreads it
  // onto its own element the way this test harness spreads everything else.
  const { cancel: _cancel, ...domProps } = useContextMenuTrigger(onOpen);
  return React.createElement("div", { "data-testid": "trigger", ...domProps }, "card");
}

function touchDown(el: Element, x = 10, y = 10) {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y });
}
function touchMove(el: Element, x: number, y: number) {
  fireEvent.pointerMove(el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y });
}
function touchUp(el: Element, x = 10, y = 10) {
  fireEvent.pointerUp(el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y });
}
function touchCancel(el: Element, x = 10, y = 10) {
  fireEvent.pointerCancel(el, { pointerId: 1, pointerType: "touch", clientX: x, clientY: y });
}

/**
 * React's own work-loop schedules its next pass with `setImmediate`, which
 * `mock.timers` here deliberately leaves REAL (only `setTimeout` is faked —
 * see below). A `setPressing()` call inside the hook queues one of those on
 * every press, and the callback fires by the time the whole FILE tears its
 * DOM down in `after()`, throwing "window is not defined" from inside React
 * with no test left to attribute it to. Draining the real macrotask queue
 * once per test, before the fake timers are torn down, is what stops it —
 * `mock.timers.tick` only advances the FAKE clock and does nothing for this.
 */
function flushReact(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("useContextMenuTrigger — long-press opens a menu on touch", () => {
  afterEach(() => {
    cleanup();
  });

  // Fake timers are enabled AFTER the render and reset BEFORE the test ends —
  // only `setTimeout` is faked (the hook's own long-press timer), so React's
  // real scheduling is untouched and `flushReact()` above still works.
  test(`held ${LONG_PRESS_MS}ms opens at the press point`, async () => {
    const onOpen = mock.fn();
    const { getByTestId } = render(React.createElement(Trigger, { onOpen }));
    const el = getByTestId("trigger");

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      touchDown(el, 42, 84);
      assert.equal(onOpen.mock.callCount(), 0, "must not open before the hold completes");
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onOpen.mock.callCount(), 1, "must open once the hold completes");
      assert.deepEqual(onOpen.mock.calls[0].arguments[0], { x: 42, y: 84 });
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });

  test("released at 300ms — short of the threshold — does not open", async () => {
    const onOpen = mock.fn();
    const { getByTestId } = render(React.createElement(Trigger, { onOpen }));
    const el = getByTestId("trigger");

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      touchDown(el);
      mock.timers.tick(300);
      touchUp(el);
      // Run out whatever time remains — a lingering timer must have been
      // cancelled by the release, not merely delayed.
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onOpen.mock.callCount(), 0, "a release before the hold completes must not open the menu");
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });

  test(`moved ${MOVE_CANCEL_PX + 2}px cancels the press`, async () => {
    const onOpen = mock.fn();
    const { getByTestId } = render(React.createElement(Trigger, { onOpen }));
    const el = getByTestId("trigger");

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      touchDown(el, 0, 0);
      touchMove(el, MOVE_CANCEL_PX + 2, 0);
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onOpen.mock.callCount(), 0, "movement past the threshold must cancel the press");
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });

  test("a mouse pointerdown never starts a long press", async () => {
    const onOpen = mock.fn();
    const { getByTestId } = render(React.createElement(Trigger, { onOpen }));
    const el = getByTestId("trigger");

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      fireEvent.pointerDown(el, { pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 10 });
      mock.timers.tick(LONG_PRESS_MS * 2);
      assert.equal(onOpen.mock.callCount(), 0, "a mouse press must never open a long-press menu");
    } finally {
      mock.timers.reset();
      await flushReact();
    }
  });

  test("the click that follows a long-press open is suppressed", async () => {
    const onOpen = mock.fn();
    const { getByTestId } = render(React.createElement(Trigger, { onOpen }));
    const el = getByTestId("trigger");

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      touchDown(el);
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onOpen.mock.callCount(), 1);
      touchUp(el);
    } finally {
      mock.timers.reset();
      await flushReact();
    }

    const click = new (globalThis as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    const prevented = !el.dispatchEvent(click);
    assert.ok(prevented, "the click following a long-press release must be preventDefault()-ed");
  });

  test("a click a second later, after a pointercancel, is not swallowed", async () => {
    // IMPORTANT, reproduced before the fix: `abort()` never cleared
    // `suppressNext`, and the click suppression it fed had no time bound at
    // all — a menu opened by a long press, then torn away by a
    // `pointercancel` (a system gesture stealing the pointer) rather than the
    // usual `pointerup`, left the flag stuck set with no click ever arriving
    // to consume it. The NEXT click, unrelated and possibly from a mouse,
    // was swallowed regardless of how much later it landed, because a mouse
    // pointerdown returns early and never reaches the reset.
    const onOpen = mock.fn();
    const { getByTestId } = render(React.createElement(Trigger, { onOpen }));
    const el = getByTestId("trigger");

    // Date faked alongside setTimeout, so the 700ms click-suppression window
    // is measured against the SAME clock the test advances — a real 1000ms
    // sleep here would make an already-slow suite slower for no reason.
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      touchDown(el);
      mock.timers.tick(LONG_PRESS_MS);
      assert.equal(onOpen.mock.callCount(), 1);
      touchCancel(el);
      // Well past the 700ms window a click from the SAME press would still be
      // suppressed inside.
      mock.timers.tick(1000);
    } finally {
      mock.timers.reset();
      await flushReact();
    }

    let reached = false;
    el.addEventListener("click", () => { reached = true; });
    const click = new (globalThis as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(click);
    assert.ok(reached, "an unrelated click a second later must reach the element's own handler");
  });
});

// ── Proof the guard is real ──────────────────────────────────────────────
//
// Confirmed in this session: temporarily changed `LONG_PRESS_MS = 500` to
// `LONG_PRESS_MS = 100` in context-menu-trigger.ts and reran this file. The
// "released at 300ms — short of the threshold — does not open" test above
// went red (a 300ms hold now clears a 100ms threshold and opens, so
// `onOpen.mock.callCount()` was 1, not the asserted 0). Reverted immediately
// after — see the PR description for the failing-run transcript.

after(() => teardown());
