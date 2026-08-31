// drawer-drag.ts — close the navigation drawer by dragging it off the screen,
// with the drawer under the finger the whole way.
//
// WHAT THIS IS NOT. It is not a threshold that fires an animation on lift. The
// drawer's `transform` is written from the pointer's position on every move, so
// at 40px of travel the drawer is 40px off the screen and the scrim is 40/width
// lighter. The thing this replaced measured `dx` at `touchend` and set a state
// flag, which is why a 44px drag did nothing and a 50px drag teleported.
//
// WHY CLOSING AND NOT OPENING. A close gesture starts on our own overlay, well
// inside the screen, and travels LEFT — away from the direction the browser's
// back gesture travels, and outside the edge zone it lives in. It contests
// nothing, needs to cancel nothing, and behaves identically on iOS, Android and
// a desktop mouse. Opening from the left edge does none of that; see the note at
// the head of components/ui/split-view.tsx.
//
// NO NON-PASSIVE LISTENER, AND NONE NEEDED. React registers `touchstart` and
// `touchmove` as `passive: true` (facebook/react#19654, still true in React 19),
// so a `preventDefault()` in a synthetic touch handler is a no-op — do not write
// one and assume it works. This uses Pointer Events and never calls
// `preventDefault` at all: `touch-action: pan-y` on the drawer declares the
// split declaratively, giving the browser the vertical axis for the drawer's own
// scroller and leaving us the horizontal one.
//
// NO DEPENDENCY. A gesture library here would import a general drag-and-fling
// solution for one drawer, one axis and two resting states.

import * as React from "react";
import { prefersReducedMotion } from "./use-slide-on-move";

/** Fling speed, px/ms, that closes the drawer whatever the distance travelled.
 *  A fast 30px throw is a dismissal; distance alone would strand it. */
export const CLOSE_VELOCITY_PX_MS = 0.5;

/** Fraction of the drawer's width past which a SLOW drag closes it. Velocity
 *  alone would strand a deliberate drag that never got fast. */
export const CLOSE_FRACTION = 0.5;

/**
 * How recent a move sample has to be for its velocity to count.
 *
 * The bug this exists for: a finger travels fast, STOPS, rests, then lifts. No
 * `pointermove` fires while it rests, so the newest sample is however old the
 * rest was — and reading it flings a drawer the operator had deliberately
 * parked. Past this age the gesture is treated as having no velocity and the
 * distance rule decides alone.
 */
export const VELOCITY_WINDOW_MS = 80;

/** Travel before a gesture becomes a drag rather than a tap or a scroll. */
export const DRAG_SLOP_PX = 8;

export interface DragSample {
  /** Pointer x, in client px. */
  x: number;
  /** `event.timeStamp`, in ms. */
  t: number;
}

/**
 * Speed over the last {@link VELOCITY_WINDOW_MS} of travel, px/ms, POSITIVE in
 * the closing direction (leftwards). `null` means "no trustworthy reading" and
 * the caller must fall back to distance.
 *
 * Measured across the window rather than between the last two samples: one
 * frame's delta on a 120Hz screen is a few px over ~8ms, which is noise
 * amplified by a factor of a hundred.
 *
 * @param now  the timestamp of the LIFT, on the same clock as the samples.
 */
export function recentVelocity(
  samples: readonly DragSample[],
  now: number,
  maxAgeMs: number = VELOCITY_WINDOW_MS,
): number | null {
  if (samples.length < 2) return null;
  const last = samples[samples.length - 1];
  // The finger had already stopped. See VELOCITY_WINDOW_MS.
  if (now - last.t > maxAgeMs) return null;
  // The oldest sample still inside the window.
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > maxAgeMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (dt <= 0) return null;
  // first.x - last.x: moving left gives a positive (closing) velocity.
  return (first.x - last.x) / dt;
}

/**
 * Where the drawer comes to rest.
 *
 * Both rules, not either alone. Velocity alone strands a slow deliberate drag
 * that reached 80% of the width; distance alone ignores a flick that only
 * travelled 30px. A flick back towards the open position reopens it whatever
 * the distance, which is what makes a mis-started drag recoverable.
 *
 * @param offset    px the drawer has been dragged off its open position (>= 0).
 * @param width     the drawer's width in px.
 * @param velocity  from {@link recentVelocity}; `null` = no trustworthy reading.
 */
export function settleTarget(
  offset: number,
  width: number,
  velocity: number | null,
): "closed" | "open" {
  // A zero-width drawer is not a thing anyone can have dragged anywhere, and
  // dividing by it would decide by NaN.
  if (!(width > 0)) return "open";
  if (velocity !== null && velocity >= CLOSE_VELOCITY_PX_MS) return "closed";
  if (velocity !== null && velocity <= -CLOSE_VELOCITY_PX_MS) return "open";
  return offset >= width * CLOSE_FRACTION ? "closed" : "open";
}

/**
 * How opaque the scrim is at `offset` px of travel: full at rest, gone at the
 * closed position. Interpolated rather than transitioned, so the ground behind
 * the drawer lightens under the finger along with it.
 */
export function scrimOpacity(offset: number, width: number): number {
  if (!(width > 0)) return 1;
  return Math.min(1, Math.max(0, 1 - offset / width));
}

/**
 * The drawer's offset for a pointer at `x`, clamped to the travel that exists.
 *
 * Clamped at 0 rather than allowed to go negative: dragging RIGHT on an already
 * open drawer has nowhere to go, and letting it slide out from under the scrim
 * would be motion that means nothing. Clamped at `width` so a long throw cannot
 * park it beyond its own closed position and leave a gap on the settle back.
 */
export function dragOffset(
  startOffset: number,
  startX: number,
  x: number,
  width: number,
): number {
  return Math.min(width, Math.max(0, startOffset + (startX - x)));
}

/**
 * The x translation a computed `transform` string is currently applying.
 *
 * This is what makes the gesture interruptible: grabbing a drawer that is
 * mid-settle reads the LIVE interpolated matrix and adopts it as the new origin.
 * Testing a stored `open` flag instead would make a closing drawer unreachable
 * the instant the settle started, which is the whole thing being avoided.
 */
export function currentTranslateX(transform: string): number {
  const s = transform.trim();
  if (!s || s === "none") return 0;
  const open = s.indexOf("(");
  if (open < 0 || !s.endsWith(")")) return 0;
  const fn = s.slice(0, open);
  const parts = s.slice(open + 1, -1).split(",").map((p) => Number.parseFloat(p));
  // matrix(a,b,c,d,tx,ty) → index 4. matrix3d has tx at index 12.
  const i = fn === "matrix3d" ? 12 : fn === "matrix" ? 4 : -1;
  if (i < 0 || parts.length <= i) return 0;
  const tx = parts[i];
  return Number.isFinite(tx) ? tx : 0;
}

/** A resolved `transition-duration` in ms, whatever unit the browser reports.
 *  Read back from the element AFTER the transition is set, so the value already
 *  accounts for the global reduced-motion override. */
function transitionMs(el: HTMLElement): number {
  const d = getComputedStyle(el).transitionDuration.split(",")[0].trim();
  const n = Number.parseFloat(d);
  if (!Number.isFinite(n)) return 0;
  return d.endsWith("ms") ? n : n * 1000;
}

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** Offset already applied when the grab began — non-zero when the drawer was
   *  caught mid-settle. */
  startOffset: number;
  width: number;
  /** The axis is locked once, on the first move past the slop, and never
   *  reconsidered. Switching axis mid-drag is its own kind of jank. */
  engaged: boolean;
  abandoned: boolean;
  offset: number;
  samples: DragSample[];
}

export interface DrawerDragHandlers {
  /** Attach to the drawer element. */
  drawerRef: (el: HTMLElement | null) => void;
  /** Attach to the scrim, so it lightens with the drag. Optional. */
  overlayRef: (el: HTMLElement | null) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
}

/**
 * Drag the drawer closed.
 *
 * @param onClose  called once the drawer has finished travelling off-screen —
 *                 NOT at the moment the decision is made. The element has to
 *                 stay mounted for the settle, both so it can be seen to leave
 *                 and so it can be grabbed again mid-flight.
 */
export function useDrawerDrag(onClose: () => void): DrawerDragHandlers {
  const drawer = React.useRef<HTMLElement | null>(null);
  const overlay = React.useRef<HTMLElement | null>(null);
  const gesture = React.useRef<Gesture | null>(null);
  const frame = React.useRef(0);
  const settleTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest settle wins. A settle started before a new grab must not fire its
  // completion into the middle of that grab.
  const settleId = React.useRef(0);

  const paint = React.useCallback(() => {
    frame.current = 0;
    const el = drawer.current;
    const g = gesture.current;
    if (!el || !g) return;
    el.style.transform = `translate3d(${-g.offset}px, 0, 0)`;
    const ov = overlay.current;
    if (ov) ov.style.opacity = String(scrimOpacity(g.offset, g.width));
  }, []);

  const schedule = React.useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }, [paint]);

  /** Stop transitioning and hold whatever is on screen right now. */
  const freeze = React.useCallback((el: HTMLElement, ov: HTMLElement | null, atX: number, width: number) => {
    // transitionProperty, not transitionDuration: the global reduced-motion rule
    // forces `transition-duration: 1ms !important`, which an inline duration
    // cannot beat. With no property listed, nothing transitions at any duration.
    el.style.transitionProperty = "none";
    el.style.transform = `translate3d(${atX}px, 0, 0)`;
    if (ov) {
      ov.style.transitionProperty = "none";
      ov.style.opacity = String(scrimOpacity(-atX, width));
    }
  }, []);

  /** Hand the element back to the stylesheet. */
  const thaw = React.useCallback(() => {
    const el = drawer.current;
    if (el) {
      el.style.transitionProperty = "";
      el.style.transitionDuration = "";
      el.style.transitionTimingFunction = "";
      el.style.transform = "";
      el.style.willChange = "";
    }
    const ov = overlay.current;
    if (ov) {
      ov.style.transitionProperty = "";
      ov.style.transitionDuration = "";
      ov.style.transitionTimingFunction = "";
      ov.style.opacity = "";
    }
  }, []);

  const cancelSettle = React.useCallback(() => {
    settleId.current += 1;
    if (settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  }, []);

  // `onClose` is a dependency rather than being smuggled through a ref: writing
  // a ref during render is exactly what the lint rule forbids, and the caller's
  // handler is a stable useCallback, so nothing actually rebuilds. The two REF
  // CALLBACKS below keep empty deps, which is the identity that matters — a
  // changing one would detach and reattach the drawer element every render.
  const settle = React.useCallback((target: "closed" | "open", width: number) => {
    const el = drawer.current;
    const ov = overlay.current;
    if (!el) return;
    const to = target === "closed" ? width : 0;
    // A compositor layer costs memory for a gesture that happens a few times a
    // service. It exists for the drag and no longer.
    el.style.willChange = "";

    const finish = () => {
      settleTimer.current = null;
      gesture.current = null;
      if (target === "closed") {
        // Leave the transform where it is: the element unmounts from here, and
        // clearing it first would flash the drawer back at x=0 for a frame.
        onClose();
      } else {
        thaw();
      }
    };

    if (prefersReducedMotion()) {
      // The DRAG still tracked the finger — direct manipulation is not the
      // unrequested motion the setting is about. Only the settle is instant.
      el.style.transitionProperty = "none";
      el.style.transform = `translate3d(${-to}px, 0, 0)`;
      if (ov) {
        ov.style.transitionProperty = "none";
        ov.style.opacity = target === "closed" ? "0" : "1";
      }
      finish();
      return;
    }

    // The tokens by name, not a literal: --motion-settled is what everything
    // else that travels uses.
    for (const node of [el, ov]) {
      if (!node) continue;
      node.style.transitionProperty = node === el ? "transform" : "opacity";
      node.style.transitionDuration = "var(--motion-settled)";
      node.style.transitionTimingFunction = "var(--motion-ease-out)";
    }
    el.style.transform = `translate3d(${-to}px, 0, 0)`;
    if (ov) ov.style.opacity = target === "closed" ? "0" : "1";

    const id = ++settleId.current;
    // A timer rather than `transitionend`: that event does not fire when the
    // resolved duration is 0, and it fires per-property on an element that may
    // grow another transition later. The read-back duration already includes
    // whatever the reduced-motion override did to it.
    settleTimer.current = setTimeout(() => {
      if (settleId.current === id) finish();
    }, transitionMs(el) + 40);
  }, [thaw, onClose]);

  React.useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
  }, []);

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    const el = drawer.current;
    if (!el) return;
    // Left button only for a mouse; touch and pen report button 0 too.
    if (e.button !== 0) return;
    cancelSettle();
    // ADOPT THE LIVE TRANSFORM. Not a stored open/closed flag — a drawer that is
    // settling is at some fraction of its travel, and that fraction is where
    // this grab has to start from.
    const live = currentTranslateX(getComputedStyle(el).transform);
    const width = el.getBoundingClientRect().width;
    freeze(el, overlay.current, live, width);
    gesture.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startOffset: -live,
      width,
      engaged: false,
      abandoned: false,
      offset: -live,
      samples: [{ x: e.clientX, t: e.timeStamp }],
    };
  }, [cancelSettle, freeze]);

  const onPointerMove = React.useCallback((e: React.PointerEvent) => {
    const g = gesture.current;
    const el = drawer.current;
    if (!g || !el || g.abandoned || e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (!g.engaged) {
      // Vertical wins → this gesture belongs to the drawer's scroller, and we
      // never look at it again. (`touch-action: pan-y` means the browser will
      // usually have taken it and sent a pointercancel before we get here.)
      if (Math.abs(dy) >= DRAG_SLOP_PX && Math.abs(dy) > Math.abs(dx)) {
        g.abandoned = true;
        thaw();
        return;
      }
      if (Math.abs(dx) < DRAG_SLOP_PX || Math.abs(dx) <= Math.abs(dy)) return;
      g.engaged = true;
      // Re-origin at the engage point so the drawer does not jump by the slop.
      // From here it is 1:1 with the finger.
      g.startX = e.clientX;
      g.samples = [{ x: e.clientX, t: e.timeStamp }];
      // Capture retargets the rest of the gesture — and the click that would
      // otherwise land on whatever rail item the drag started on — to the
      // drawer itself.
      try {
        el.setPointerCapture(g.pointerId);
      } catch {
        // Not fatal: without capture the drag still tracks while the pointer is
        // over the drawer, and pointercancel settles it if it leaves. Rethrowing
        // would abort a gesture over a browser quirk.
      }
      el.style.willChange = "transform";
    }

    g.offset = dragOffset(g.startOffset, g.startX, e.clientX, g.width);
    g.samples.push({ x: e.clientX, t: e.timeStamp });
    // Enough to span the velocity window at 120Hz with room to spare; an
    // unbounded array on a long slow drag is a leak that grows with the gesture.
    if (g.samples.length > 16) g.samples.shift();
    schedule();
  }, [schedule, thaw]);

  const endGesture = React.useCallback((e: React.PointerEvent, cancelled: boolean) => {
    const g = gesture.current;
    const el = drawer.current;
    if (!g || !el || e.pointerId !== g.pointerId) return;
    if (el.hasPointerCapture?.(g.pointerId)) el.releasePointerCapture(g.pointerId);
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    if (!g.engaged || g.abandoned) {
      // A tap, or a scroll. Nothing moved; hand the styles back.
      gesture.current = null;
      thaw();
      return;
    }
    // The lift position is deliberately NOT appended as a sample: it would make
    // the newest sample exactly as old as `now`, and the recency gate — the
    // whole point of it — could never fire.
    const v = cancelled ? null : recentVelocity(g.samples, e.timeStamp);
    settle(cancelled ? "open" : settleTarget(g.offset, g.width, v), g.width);
  }, [settle, thaw]);

  const onPointerUp = React.useCallback((e: React.PointerEvent) => endGesture(e, false), [endGesture]);
  const onPointerCancel = React.useCallback((e: React.PointerEvent) => endGesture(e, true), [endGesture]);

  const drawerRef = React.useCallback((el: HTMLElement | null) => {
    drawer.current = el;
  }, []);
  const overlayRef = React.useCallback((el: HTMLElement | null) => {
    overlay.current = el;
  }, []);

  return { drawerRef, overlayRef, onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
