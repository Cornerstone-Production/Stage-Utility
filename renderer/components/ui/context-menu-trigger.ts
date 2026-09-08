// context-menu-trigger.ts — the one way a menu opens, on a mouse OR a finger.
//
// Every menu in this app opened only through the browser's own `contextmenu`
// event, which a right-click fires and a touch never does. iPad Safari synthesizes
// nothing in its place: the platform's own "long-press to select text" is a
// different gesture aimed at a different target, and it does not reach a
// `contextmenu` handler at all. So every menu — the context bar's configurator,
// the Home card pickers, the History chart's menu — was unreachable on a touch
// device, full stop.
//
// This hook is the one place that gap is closed: it reimplements "press and
// hold" over raw Pointer Events, gated to touch and pen so a mouse keeps its
// existing, unrelated `contextmenu` behaviour untouched.
//
// A LONG PRESS. Not "the first pointerdown"— that would fire on every tap and
// make an ordinary touch fire a menu instead of the widget beneath it. It needs
// to be held, and held STILL: a pan or a drag starting under the same finger
// must be free to win the gesture instead.

import {
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";

/** How long a touch or pen must be held before it counts as a long press. */
export const LONG_PRESS_MS = 500;

/** How far the pointer may drift, in CSS px, before the press is cancelled. */
export const MOVE_CANCEL_PX = 8;

/**
 * Elements a press must never start a long-press timer on top of. A hold on a
 * Switch, a button, or any other control inside a trigger has its own meaning
 * (or none at all — see the app's other press-and-hold, `Switch`), and must not
 * ALSO open the menu that sits behind it 500ms later.
 */
const CONTROL_SELECTOR = "button, a, select, input, textarea, [role='combobox'], [role='button'], [contenteditable]";

/**
 * How long after a long press opens a menu its trailing synthesized click is
 * still swallowed. Bounded, rather than "until the next click": a `pointercancel`
 * (a system gesture stealing the pointer, a lost capture) never fires a
 * matching click at all, so a boolean that only `onClickCapture` could clear
 * stayed set — and swallowed the NEXT, unrelated click, including a plain mouse
 * click, however much later it landed.
 */
const CLICK_SUPPRESS_MS = 700;

export interface ContextMenuTriggerProps {
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (e: SyntheticEvent) => void;
  /**
   * `-webkit-touch-callout: none` and `user-select: none`, WHILE a press is in
   * progress only — not permanently. A permanent `user-select: none` would kill
   * text selection on any trigger that also carries copyable text (the History
   * chart sits beside numeric readouts an operator might want to select), so
   * this is applied only for the ~500ms a press is actually being timed, then
   * released whether the press became a menu or not.
   */
  style: CSSProperties | undefined;
  /**
   * Ends the timed press without opening anything — for a caller that owns a
   * COMPETING gesture over the same pointer (Home's card drag) and wants to
   * kill the long press the moment ITS gesture actually starts, rather than
   * trust the two thresholds to stay in step. See `MOVE_CANCEL_PX` and
   * `cancelPx` below: matching the numbers helps, but a drag that starts on
   * its own 4px while this hook still waits for 8px would open a menu on top
   * of a live drag — reproduced with a 5px move held still for 500ms.
   */
  cancel: () => void;
}

export interface UseContextMenuTriggerOptions {
  /**
   * How far the pointer may drift, in CSS px, before the press cancels
   * itself. Defaults to `MOVE_CANCEL_PX`. A caller with its own, tighter
   * gesture threshold (Home's card drag starts at 4px) should pass that same
   * number here so the two guards agree — though `cancel()` above is what
   * actually closes the gap between them, not this number alone.
   */
  cancelPx?: number;
}

/**
 * Returns the props to spread on a menu's trigger element.
 *
 * `open` is called with the point the menu should appear at — the press
 * origin for a long press, the cursor for a right-click.
 */
export function useContextMenuTrigger(
  open: (point: { x: number; y: number }) => void,
  options?: UseContextMenuTriggerOptions,
): ContextMenuTriggerProps {
  const cancelPx = options?.cancelPx ?? MOVE_CANCEL_PX;
  // A ref, not state: the values inside are read and mutated from pointer
  // callbacks that fire faster than a render can commit, and none of them are
  // ever painted — only `pressing` (below) is.
  const gesture = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    pointerId: number | null;
    startX: number;
    startY: number;
    /** Set once the long press has fired, so the NATIVE default action on the
     *  pointerup that follows the same finger's lift is suppressed — read and
     *  reset entirely within `onPointerUp`, never carried past it. */
    suppressNext: boolean;
    /** When the long press last fired, or null. Read by `onClickCapture` to
     *  decide whether the click it is seeing is the synthesized tail of THIS
     *  press (see `CLICK_SUPPRESS_MS`) — a timestamp rather than a boolean so a
     *  press that opens and is then torn away by a `pointercancel`, with no
     *  click ever following it, does not leave a flag that swallows some
     *  unrelated later click, mouse or touch, forever. */
    openedAt: number | null;
  }>({ timer: null, pointerId: null, startX: 0, startY: 0, suppressNext: false, openedAt: null });

  // The only piece that needs to repaint: the callout/selection suppression
  // while a press is being timed.
  const [pressing, setPressing] = useState(false);

  function clearTimer() {
    if (gesture.current.timer != null) {
      clearTimeout(gesture.current.timer);
      gesture.current.timer = null;
    }
  }

  /** End the gesture without opening anything — a lift, a cancel, a second
   *  finger, or too much movement. Also the caller-facing `cancel()`: a
   *  COMPETING gesture (Home's card drag) calling this the moment IT starts is
   *  what actually closes the mid-drag-menu gap, not `cancelPx` alone. */
  function abort() {
    clearTimer();
    gesture.current.pointerId = null;
    // `suppressNext` only ever needs to survive from the timer firing to the
    // `onPointerUp` that follows it — see the field's own comment — and every
    // caller of `abort()` other than that same `onPointerUp` represents a
    // press that is ending WITHOUT that pointerup ever seeing it (a cancel, a
    // second finger, too much movement, an external `cancel()`). Resetting it
    // here does not touch `onPointerUp`'s own read of it, which already ran
    // before `onPointerUp` calls this.
    gesture.current.suppressNext = false;
    setPressing(false);
  }

  function withinControl(e: ReactPointerEvent<HTMLElement>): boolean {
    return e.target instanceof HTMLElement && e.target.closest(CONTROL_SELECTOR) != null;
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (e.pointerType === "mouse") return;
    // A hold on a control inside the trigger — a Switch, a button, anything
    // with its own press behaviour — must not ALSO start timing a long press
    // that opens a menu on top of it 500ms later. Reproduced: a 500ms hold on
    // an inner `<button>` opened the menu before this guard existed.
    if (withinControl(e)) return;
    // A second finger while one is already being timed cancels the first
    // rather than racing it — two fingers down is a different gesture (pinch,
    // scroll), never "open the menu twice."
    if (gesture.current.pointerId != null) {
      abort();
      return;
    }
    gesture.current.pointerId = e.pointerId;
    gesture.current.startX = e.clientX;
    gesture.current.startY = e.clientY;
    gesture.current.suppressNext = false;
    setPressing(true);
    const { clientX, clientY } = e;
    gesture.current.timer = setTimeout(() => {
      gesture.current.timer = null;
      gesture.current.suppressNext = true;
      gesture.current.openedAt = Date.now();
      setPressing(false);
      open({ x: clientX, y: clientY });
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (e.pointerType === "mouse") return;
    if (gesture.current.pointerId !== e.pointerId) return;
    const dx = e.clientX - gesture.current.startX;
    const dy = e.clientY - gesture.current.startY;
    if (Math.hypot(dx, dy) > cancelPx) abort();
  }

  function onPointerUp(e: ReactPointerEvent<HTMLElement>) {
    if (e.pointerType === "mouse") return;
    if (gesture.current.pointerId !== e.pointerId) return;
    // The long press already opened the menu on the timer above — this lift is
    // the release of the SAME touch, and must not also act as a tap on
    // whatever the finger happens to be resting on.
    if (gesture.current.suppressNext) e.preventDefault();
    abort();
  }

  function onPointerCancel(e: ReactPointerEvent<HTMLElement>) {
    if (e.pointerType === "mouse") return;
    if (gesture.current.pointerId !== e.pointerId) return;
    abort();
    // A cancel — a system gesture stealing the pointer, a lost capture — never
    // fires the matching click a `pointerup` would have, so a menu that had
    // already opened leaves no click for `onClickCapture` to consume. Clearing
    // the open timestamp here is belt-and-suspenders over the 700ms decay in
    // `onClickCapture`: either alone already stops the next click from being
    // swallowed, reproduced by opening, cancelling, then dispatching a click
    // 1s later and watching it reach the element's own handler.
    gesture.current.openedAt = null;
  }

  function onContextMenu(e: ReactMouseEvent<HTMLElement>) {
    e.preventDefault();
    open({ x: e.clientX, y: e.clientY });
  }

  /**
   * The click that a touch's own pointerup/pointerdown pair synthesizes right
   * after it, suppressed exactly once. `preventDefault` on `pointerup` above
   * stops a NATIVE default action (following a link, checking a checkbox) but
   * does nothing about React's own click — which still fires from the browser's
   * synthesized `click` event on the same sequence. Capture phase, so it beats
   * whatever `onClick` the trigger element itself carries.
   */
  function onClickCapture(e: SyntheticEvent) {
    const openedAt = gesture.current.openedAt;
    if (openedAt == null) return;
    // Consumed unconditionally on the first click seen after an open, whether
    // or not it falls inside the window — a click this hook does not swallow
    // must never be re-examined by a LATER one either.
    gesture.current.openedAt = null;
    if (Date.now() - openedAt > CLICK_SUPPRESS_MS) return;
    e.preventDefault();
    e.stopPropagation();
  }

  return {
    onContextMenu,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
    style: pressing ? { WebkitTouchCallout: "none", userSelect: "none" } : undefined,
    cancel: abort,
  };
}
