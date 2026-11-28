// One pointer gesture, bound to the window, guaranteed to end.
//
// Every drag on a touch screen in this app goes through here. Rolling a
// pointermove/pointerup pair by hand is what the editor did, and it is wrong in
// three ways that a mouse never shows you:
//
// - **Capture.** A finger is wider than the thing it grabbed, so the contact
//   drifts off the element within a pixel or two and the element stops hearing
//   about it. Capture pins the rest of the sequence to the element that took the
//   pointerdown, wherever the finger goes.
// - **pointercancel.** iOS takes the pointer for a system gesture, or the
//   browser decides mid-gesture that it was a scroll. There is no pointerup
//   after that: hand-rolled listeners stay bound to the window and the next
//   stray move resumes a gesture the operator stopped making.
// - **One pointer.** A second contact reports its own pointerId, and its moves
//   belong to nothing here.
//
// `end` runs exactly once, with `cancelled` saying which of the two it was.
// Listeners and capture are already gone by the time it runs, so an `end` that
// throws still leaves nothing bound.

/**
 * How far a finger may travel before the gesture stops being a tap.
 *
 * A mouse gets zero: a click is a click and the pointer does not wobble. A
 * finger always wobbles — a tap lands a few px from where it lifts — so without
 * a floor every tap on an object nudged it and marked the layout dirty, and
 * every tap on bare canvas drew a one-pixel marquee instead of clearing the
 * selection. 8px is under the 9px handle and well under a fingertip.
 *
 * Lives here, with the gestures, so the editor canvas and the palette cannot
 * drift to two different ideas of what a tap is.
 */
export const TOUCH_SLOP_PX = 8;

/** Unbind a gesture without ending it. See `bindGesture`. */
export type GestureHandle = { cancel: () => void };

export function bindGesture(
  el: Element,
  pointerId: number,
  handlers: {
    move: (e: globalThis.PointerEvent) => void;
    end: (e: globalThis.PointerEvent, cancelled: boolean) => void;
  },
): GestureHandle {
  // jsdom does not implement pointer capture; a browser always does.
  if (typeof el.setPointerCapture === "function") el.setPointerCapture(pointerId);
  const onMove = (e: globalThis.PointerEvent) => {
    if (e.pointerId === pointerId) handlers.move(e);
  };
  const off = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    if (typeof el.hasPointerCapture === "function" && el.hasPointerCapture(pointerId)) {
      el.releasePointerCapture(pointerId);
    }
  };
  const onUp = (e: globalThis.PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    off();
    handlers.end(e, false);
  };
  const onCancel = (e: globalThis.PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    off();
    handlers.end(e, true);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  // `cancel` is for the component going away, not for the gesture ending. A
  // marquee or a palette drag still in flight when its owner unmounts has to let
  // go of the window: `end` there would call setState and onSelect into a tree
  // that no longer exists, and leaving the listeners bound means the next stray
  // move drives a dead component. So it unbinds and releases capture, and
  // deliberately does NOT run `end` — nothing was decided.
  return { cancel: off };
}
