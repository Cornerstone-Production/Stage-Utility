import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * An element's own box, `clientWidth` by `clientHeight` (padding in, border and
 * scrollbar out), watched as it resizes: the room a widget has to lay itself
 * out in.
 *
 * `{ w: 0, h: 0 }` until the first measurement, which is taken before the first
 * paint, so the element must already be attached when the hook mounts. 0 is
 * also all a DOM with no layout (jsdom) ever reports, so a caller decides what
 * 0 means to it: "not measured, show the default", or "no room". With no
 * ResizeObserver it is measured once.
 *
 * The box's own size, never its content's. A fit that reads the content back
 * (scrollWidth, offsetHeight) is fit-to-box.ts's job, and
 * fit-one-measurement.test.ts lists every place that does.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      // The same object when nothing changed, so a resize that leaves the box
      // as it was renders nothing.
      setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
