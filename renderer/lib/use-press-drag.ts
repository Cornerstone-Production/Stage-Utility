// A press that becomes a drag: the one gesture a StagePlots plot tab (reorder)
// and palette item (drop on the plot) share.
//
// A press on an element that moves past `slop` screen pixels is a drag, and
// until then it is an ordinary click. The hook holds the parts that are easy to
// get wrong twice:
//
//  - The pointer is captured from the press, so a quick first move that leaves
//    the element is still this drag's.
//  - Escape cancels a drag under way: nothing is dropped, and `onEnd` runs.
//  - The click the browser sends after a drag (and after an Escape-cancelled
//    one, once the pointer is let go) is swallowed, once. It is armed at the
//    release and disarmed by that click, the next press, or the next task: a
//    drag with no click after it, or an Escape-cancelled one, must not eat a
//    later keyboard Enter or Space click. A keyboard click has `detail` 0 and is
//    never swallowed.
//
// The caller wires `press`, `move`, `up` and `cancel` to the element's pointer
// events and asks `claimClick` first in its click handler.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLatestRef } from "./use-latest-ref";

export interface PressDragOptions<P> {
  /** How far, in screen pixels, a press moves before it is a drag and not a click. */
  slop: number;
  /** `"x"` measures only horizontal travel (a tab row); `"xy"` the distance. */
  axis?: "x" | "xy";
  /** Each pointer move once the press is a drag. */
  onMove: (payload: P, e: ReactPointerEvent<Element>) => void;
  /** The pointer let go after a drag. Not called for Escape or a cancelled pointer. */
  onDrop: (payload: P, e: ReactPointerEvent<Element>) => void;
  /** The drag is over for any reason: drop, Escape or a cancelled pointer. Clear what it drew. */
  onEnd?: () => void;
}

export interface PressDrag<P> {
  /** A press that may become a drag. Primary button only; the caller refuses a press it does not want first. */
  press: (e: ReactPointerEvent<Element>, payload: P) => void;
  /** True once the press is a drag. */
  move: (e: ReactPointerEvent<Element>) => boolean;
  up: (e: ReactPointerEvent<Element>) => void;
  cancel: (e: ReactPointerEvent<Element>) => void;
  /** True when this click is the one that follows a drag, and so must do nothing. */
  claimClick: (e: { detail: number }) => boolean;
}

interface Press<P> {
  payload: P;
  pointerId: number;
  x: number;
  y: number;
  dragging: boolean;
  /** Escape ended the drag; the pointer may still be down. */
  escaped: boolean;
}

export function usePressDrag<P>(options: PressDragOptions<P>): PressDrag<P> {
  const opts = useLatestRef(options);
  const current = useRef<Press<P> | null>(null);
  const swallow = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only while a drag is under way, so the Escape listener is not on the page for every press.
  const [active, setActive] = useState(false);

  const disarm = useCallback(() => {
    swallow.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  // The click follows the release in the same task; one that never comes must not outlive it.
  const arm = useCallback(() => {
    disarm();
    swallow.current = true;
    timer.current = setTimeout(disarm, 0);
  }, [disarm]);
  useEffect(() => disarm, [disarm]);

  const end = useCallback(() => {
    setActive(false);
    opts.current.onEnd?.();
  }, [opts]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const p = current.current;
      if (e.key !== "Escape" || !p || p.escaped) return;
      p.escaped = true;
      end();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, end]);

  return {
    press: (e, payload) => {
      disarm();
      current.current = { payload, pointerId: e.pointerId, x: e.clientX, y: e.clientY, dragging: false, escaped: false };
      // Held from the press, so a quick first move that leaves the element is still this drag's.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    move: (e) => {
      const p = current.current;
      if (!p || p.pointerId !== e.pointerId || p.escaped) return false;
      if (!p.dragging) {
        const dx = e.clientX - p.x;
        const dy = opts.current.axis === "x" ? 0 : e.clientY - p.y;
        if (Math.hypot(dx, dy) < opts.current.slop) return false;
        p.dragging = true;
        setActive(true);
      }
      opts.current.onMove(p.payload, e);
      return true;
    },
    up: (e) => {
      const p = current.current;
      if (!p || p.pointerId !== e.pointerId) return;
      current.current = null;
      if (p.escaped) {
        arm();
        return;
      }
      if (!p.dragging) return;
      arm();
      end();
      opts.current.onDrop(p.payload, e);
    },
    cancel: (e) => {
      const p = current.current;
      if (!p || p.pointerId !== e.pointerId) return;
      current.current = null;
      if (p.dragging && !p.escaped) end();
    },
    claimClick: (e) => {
      if (!swallow.current || e.detail === 0) return false;
      disarm();
      return true;
    },
  };
}
