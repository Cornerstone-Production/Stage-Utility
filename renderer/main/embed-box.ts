// The height an embedded view's canvas is drawn against.
//
// ONE hook, called by both `view-embed` and `screen-embed`, for the same reason
// EmbeddedView is one component: two copies of this would be two answers to
// "how big is the box", and the whole point of a producer wall is that every
// tile behaves the same.

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * MEASURED, not derived. The obvious arithmetic — `o.h * ctx.H`, or the placed
 * rect — is right only for a top-level object on a laid-out canvas. Inside a
 * container `o.h` is a fraction of the CONTAINER, so an embed filling a
 * half-height container claimed twice its box; `placed` is absent for every
 * letterboxed layout, which is most wall displays; and on Home the object's h is
 * not used to lay anything out at all (see home-cards.ts), so it means nothing.
 * The rendered box is the one thing that is true on all four paths.
 *
 * useLayoutEffect, so the measurement lands in the same commit as the first
 * paint and nothing is ever seen at the fallback size.
 *
 * @param resetKey re-measures when it changes. Required rather than optional so
 *   a third caller has to decide what its box depends on. `view-embed` needs it:
 *   its ref'd element only exists on the success path, so swapping between a
 *   notice and a view REPLACES the node and a stale observer would be watching a
 *   detached one. `screen-embed`'s body div is unconditional and passes the same
 *   key for consistency, not because it has that problem.
 */
export function useEmbedBoxHeight(resetKey: string | null): {
  ref: RefObject<HTMLDivElement | null>;
  height: number;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [resetKey]);
  return { ref, height };
}
