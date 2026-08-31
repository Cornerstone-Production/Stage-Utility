// The drag's STATE MACHINE, driven through the real hook.
//
// drawer-drag.test.ts guards the arithmetic and says plainly that feel is a
// browser question. This file guards the other half, which is not about feel at
// all: who owns a gesture, when it is abandoned, and what a stray touch does to
// a drawer that is already on its way out. Every bug below was found by review
// after the gesture had been driven in a real browser and looked perfect — a
// complete pointerdown/move/up cycle exercises none of them.
//
// jsdom has no compositor, so nothing here asserts a pixel. It asserts which
// handler ran and what was written to `style.transform`, which is exactly where
// these bugs live.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// The paint is rAF-coalesced, and jsdom's rAF runs on a ~16ms timer that does
// not flush inside `act()`. Run it synchronously: every assertion here is about
// the value that lands, never about how many frames it took to land.
// Returns 0 deliberately. The hook coalesces with `if (!frame.current)`, and a
// real rAF is async so the callback clears that slot before the id is assigned.
// Running synchronously inverts the order, so a non-zero id would latch the slot
// and suppress every paint after the first.
window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(0);
  return 0;
}) as typeof window.requestAnimationFrame;
window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;

const React = (await import("react")).default;
const { render, cleanup, act } = await import("@testing-library/react");
const { useDrawerDrag } = await import("./drawer-drag.js");

after(() => {
  cleanup();
  teardown();
});

const WIDTH = 256;

/** A drawer element with a real box, since jsdom measures everything as zero and
 *  a zero-width drawer can never be dragged anywhere. */
function drawerEl(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ width: WIDTH, height: 800, left: 0, top: 0, right: WIDTH, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  // jsdom throws NotFoundError for a pointer id it has never seen. The hook
  // already tolerates that; stubbing keeps the warning out of the test output.
  el.setPointerCapture = () => {};
  el.hasPointerCapture = () => false;
  el.releasePointerCapture = () => {};
  document.body.appendChild(el);
  return el;
}

type Handlers = ReturnType<typeof useDrawerDrag>;

/** Mount the hook and hand back its handlers plus the closes it has reported. */
function mountHook(): { h: () => Handlers; closes: () => number } {
  let handlers: Handlers | null = null;
  let closed = 0;
  function Probe() {
    handlers = useDrawerDrag(React.useCallback(() => { closed += 1; }, []));
    return null;
  }
  render(<Probe />);
  return { h: () => handlers!, closes: () => closed };
}

/** A synthetic pointer event, shaped as the handlers read it. */
function pe(type: string, x: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    pointerId: 1,
    isPrimary: true,
    button: type === "pointermove" ? -1 : 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: 400,
    timeStamp: performance.now(),
    ...over,
  } as unknown as React.PointerEvent;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("a gesture belongs to one pointer and one element", () => {
  test("a drawer that unmounts mid-drag does not hand its gesture to the next one", async () => {
    // Escape closes a Radix dialog mid-drag, so the pointerup never reaches a
    // handler bound to the element that left. Anything left behind would be
    // adopted by the NEXT drawer, because a mouse reuses pointerId 1 — and the
    // new drawer would jump to an offset measured from a startX recorded before
    // it existed, then follow a pointer with no button down.
    const { h } = mountHook();
    const first = drawerEl();
    act(() => { h().drawerRef(first); });
    act(() => { h().onPointerDown(pe("pointerdown", 200)); });
    act(() => { h().onPointerMove(pe("pointermove", 190)); }); // engage
    act(() => { h().onPointerMove(pe("pointermove", 120)); });
    assert.ok(first.style.transform.includes("-70px"), "the first drawer did not track at all");

    // It goes away, still "held".
    act(() => { h().drawerRef(null); });

    const second = drawerEl();
    act(() => { h().drawerRef(second); });
    act(() => { h().onPointerMove(pe("pointermove", 60)); });
    assert.equal(
      second.style.transform,
      "",
      "a gesture from the unmounted drawer moved the new one",
    );
  });

  test("a move with no button held is a hover, and ends the gesture", () => {
    const { h } = mountHook();
    const el = drawerEl();
    act(() => { h().drawerRef(el); });
    act(() => { h().onPointerDown(pe("pointerdown", 200)); });
    act(() => { h().onPointerMove(pe("pointermove", 190)); });
    act(() => { h().onPointerMove(pe("pointermove", 150)); });
    const held = el.style.transform;
    assert.ok(held.includes("-40px"), `expected -40px while held, got ${held}`);

    // Button released without a pointerup ever arriving (the case above).
    act(() => { h().onPointerMove(pe("pointermove", 80, { buttons: 0 })); });
    assert.equal(el.style.transform, held, "the drawer followed a pointer with nothing pressed");

    // And it stays dropped.
    act(() => { h().onPointerMove(pe("pointermove", 40)); });
    assert.equal(el.style.transform, held, "the dropped gesture resumed");
  });

  test("a second finger cannot take over, or thaw the drawer out from under the first", () => {
    // A palm graze mid-drag. The second pointer used to overwrite the gesture
    // wholesale; its lift then took the `!engaged` branch and cleared the
    // transform while finger one was still holding the drawer.
    const { h } = mountHook();
    const el = drawerEl();
    act(() => { h().drawerRef(el); });
    act(() => { h().onPointerDown(pe("pointerdown", 200)); });
    act(() => { h().onPointerMove(pe("pointermove", 190)); });
    act(() => { h().onPointerMove(pe("pointermove", 110)); });
    const held = el.style.transform;
    assert.ok(held.includes("-80px"), `expected -80px, got ${held}`);

    act(() => { h().onPointerDown(pe("pointerdown", 300, { pointerId: 2, isPrimary: false })); });
    act(() => { h().onPointerUp(pe("pointerup", 300, { pointerId: 2, isPrimary: false })); });
    assert.equal(el.style.transform, held, "a second pointer moved or reset the drawer");

    // Finger one still owns it.
    act(() => { h().onPointerMove(pe("pointermove", 90)); });
    assert.ok(el.style.transform.includes("-100px"), "the first finger lost its gesture to the second");
  });
});

describe("a stray touch does not undo a close", () => {
  test("tapping a drawer that is already settling closed lets it finish", async () => {
    // The drawer stays mounted for the length of the settle so it can be caught
    // mid-flight. A TAP in that window used to take the "nothing moved" branch
    // and thaw — clearing the transform, slamming a drawer the operator had
    // already closed back to fully open, and never calling onClose, so it stayed
    // open for good.
    const { h, closes } = mountHook();
    const el = drawerEl();
    act(() => { h().drawerRef(el); });
    act(() => { h().onPointerDown(pe("pointerdown", 200)); });
    act(() => { h().onPointerMove(pe("pointermove", 190)); });
    for (const x of [150, 100, 40]) act(() => { h().onPointerMove(pe("pointermove", x)); });
    act(() => { h().onPointerUp(pe("pointerup", 40)); });
    assert.equal(closes(), 0, "the close fired before the drawer had travelled");

    // A stray tap lands while it is still on its way out.
    act(() => { h().onPointerDown(pe("pointerdown", 120)); });
    act(() => { h().onPointerUp(pe("pointerup", 120)); });

    await act(async () => { await wait(120); });
    assert.equal(closes(), 1, "the tap cancelled a close the operator had completed");
    assert.ok(
      el.style.transform.includes(`-${WIDTH}px`),
      `the drawer was thawed back to open instead of finishing its close (${el.style.transform})`,
    );
  });

  test("tapping a drawer that is springing back still lets it spring back", async () => {
    const { h, closes } = mountHook();
    const el = drawerEl();
    act(() => { h().drawerRef(el); });
    act(() => { h().onPointerDown(pe("pointerdown", 200)); });
    act(() => { h().onPointerMove(pe("pointermove", 190)); });
    // A short, slow drag: under half the width, no speed. It springs back.
    act(() => { h().onPointerMove(pe("pointermove", 170, { timeStamp: performance.now() + 400 })); });
    act(() => { h().onPointerUp(pe("pointerup", 170, { timeStamp: performance.now() + 900 })); });

    act(() => { h().onPointerDown(pe("pointerdown", 150)); });
    act(() => { h().onPointerUp(pe("pointerup", 150)); });
    await act(async () => { await wait(120); });
    assert.equal(closes(), 0, "a drawer that was springing back closed instead");
  });

  test("a plain tap on a drawer at rest leaves it alone", async () => {
    const { h, closes } = mountHook();
    const el = drawerEl();
    act(() => { h().drawerRef(el); });
    act(() => { h().onPointerDown(pe("pointerdown", 120)); });
    act(() => { h().onPointerUp(pe("pointerup", 120)); });
    await act(async () => { await wait(80); });
    assert.equal(closes(), 0, "a tap closed the drawer");
    assert.equal(el.style.transform, "", "a tap left an inline transform behind");
  });
});
