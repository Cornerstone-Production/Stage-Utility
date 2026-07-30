import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Keep the newest `value` in a ref, for callbacks that outlive the render which
 * created them — a ResizeObserver subscribed once, a postMessage handler waiting
 * on a handshake — and would otherwise close over a stale value.
 *
 * The obvious `ref.current = value` in the component body writes a ref during
 * render, which React does not allow: a render may be thrown away or replayed,
 * and the write would survive it. Writing it in a layout effect keeps the mirror
 * current before anything can paint or observe.
 *
 * Call it above the effect that reads the ref, so the mirror is already current
 * the first time that effect runs.
 *
 * Reach for this only when a value must escape the render that produced it.
 * Anything rendered from should stay in state.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
