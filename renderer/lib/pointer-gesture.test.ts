// bindGesture: the one place a touch drag in this app is bound and unbound.
//
// Every assertion here is about the UNBINDING, because that is the half a mouse
// never exercises and the half that has been wrong. A gesture that ends without
// removing its window listeners is not a bug you see — it is the next stray
// pointermove driving a drag nobody is making, in a component that may not even
// be mounted any more.
//
// What is NOT asserted: that a real browser cancels a pointer when iOS takes it
// for a system gesture, and that capture keeps events coming when the contact
// drifts off a 9px handle. jsdom implements neither pointer capture (it is
// stubbed below, so the CALLS are visible) nor any gesture arbitration. Those
// are browser questions and were driven in one.

import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { bindGesture, TOUCH_SLOP_PX } = await import("./pointer-gesture.js");

after(teardown);

// jsdom has no pointer capture. Recording it is the point: it is invisible in
// every other assertion, and it is the reason a drag survives the finger
// drifting off what it grabbed.
const held = new Set<number>();
Element.prototype.setPointerCapture = function (id: number) { held.add(id); };
Element.prototype.hasPointerCapture = function (id: number) { return held.has(id); };
Element.prototype.releasePointerCapture = function (id: number) { held.delete(id); };

function ev(type: string, pointerId: number, x = 0, y = 0) {
  return new window.PointerEvent(type, { bubbles: true, pointerId, pointerType: "touch", clientX: x, clientY: y });
}

interface Log {
  el: HTMLElement;
  moves: number[];
  ends: { cancelled: boolean }[];
  handle: { cancel: () => void };
}

function bind(pointerId = 1): Log {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const moves: number[] = [];
  const ends: { cancelled: boolean }[] = [];
  const handle = bindGesture(el, pointerId, {
    move: (e) => moves.push(e.clientX),
    end: (_e, cancelled) => ends.push({ cancelled }),
  });
  return { el, moves, ends, handle };
}

beforeEach(() => {
  held.clear();
  document.body.innerHTML = "";
});

describe("bindGesture", () => {
  test("captures the pointer on the element that took the pointerdown", () => {
    bind(7);
    assert.ok(held.has(7), "the gesture did not capture its pointer — a finger that drifts off the element stops driving it");
  });

  test("only the bound pointer moves the gesture", () => {
    const g = bind(1);
    window.dispatchEvent(ev("pointermove", 1, 40));
    window.dispatchEvent(ev("pointermove", 2, 900));
    window.dispatchEvent(ev("pointermove", 1, 60));
    assert.deepEqual(g.moves, [40, 60], "a second contact's moves were fed to a gesture it never started");
  });

  test("pointerup ends it, unbinds, and releases the capture", () => {
    const g = bind(1);
    window.dispatchEvent(ev("pointermove", 1, 40));
    window.dispatchEvent(ev("pointerup", 1, 40));
    assert.deepEqual(g.ends, [{ cancelled: false }], "pointerup did not end the gesture exactly once, uncancelled");
    assert.equal(held.size, 0, "the element still holds the pointer after the gesture ended");

    window.dispatchEvent(ev("pointermove", 1, 500));
    assert.deepEqual(g.moves, [40], "a move after pointerup still drove the gesture — the listeners were never removed");
    window.dispatchEvent(ev("pointerup", 1, 500));
    assert.equal(g.ends.length, 1, "the gesture ended twice");
  });

  test("pointercancel ends it as cancelled, unbinds, and releases the capture", () => {
    const g = bind(1);
    window.dispatchEvent(ev("pointermove", 1, 40));
    window.dispatchEvent(ev("pointercancel", 1, 40));
    assert.deepEqual(g.ends, [{ cancelled: true }], "pointercancel did not end the gesture as cancelled");
    assert.equal(held.size, 0, "a cancelled pointer was left captured");

    window.dispatchEvent(ev("pointermove", 1, 500));
    window.dispatchEvent(ev("pointerup", 1, 500));
    assert.deepEqual(g.moves, [40], "moves after a cancel still drove the gesture");
    assert.equal(g.ends.length, 1, "a cancelled gesture ended a second time on the pointerup that never came");
  });

  test("a cancel from another pointer is ignored", () => {
    const g = bind(1);
    window.dispatchEvent(ev("pointercancel", 2));
    assert.equal(g.ends.length, 0, "another pointer's cancel ended this gesture");
    window.dispatchEvent(ev("pointermove", 1, 30));
    assert.deepEqual(g.moves, [30], "the gesture stopped listening because an unrelated pointer was cancelled");
  });

  test("the returned handle unbinds without ending", () => {
    const g = bind(1);
    window.dispatchEvent(ev("pointermove", 1, 40));
    g.handle.cancel();
    assert.deepEqual(g.ends, [], "cancel() ran the end handler — the owner is unmounting, nothing was decided");
    assert.equal(held.size, 0, "cancel() left the pointer captured");
    window.dispatchEvent(ev("pointermove", 1, 500));
    window.dispatchEvent(ev("pointerup", 1, 500));
    assert.deepEqual(g.moves, [40], "the gesture kept moving after its owner unbound it");
    assert.deepEqual(g.ends, [], "an end arrived after cancel()");
  });

  test("cancel() twice is harmless", () => {
    const g = bind(1);
    g.handle.cancel();
    g.handle.cancel();
    assert.deepEqual(g.ends, []);
  });

  test("the touch slop is under the 9px handle", () => {
    // Shared by the canvas and the palette so a tap means the same thing on
    // both. Over 9 and a finger could not land on a resize handle without the
    // press counting as a tap on the object instead.
    assert.ok(TOUCH_SLOP_PX > 0 && TOUCH_SLOP_PX < 9, `TOUCH_SLOP_PX is ${TOUCH_SLOP_PX}`);
  });
});
