import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * The width of an element, in px, kept current as it resizes.
 *
 * For a decision about how much ROOM a piece of the page has, which the window
 * width cannot answer: the same 1024px window has about 760px of page with the
 * sidebar open and about 950px with it collapsed. A media query cannot ask the
 * pane; `@container` can, but only for styling, and a layout that swaps one
 * component tree for another needs the number in JS.
 *
 * Measured before the first paint, so a page that opens wide never flashes the
 * narrow layout. 0 until the element mounts, and in an environment with no
 * ResizeObserver it is measured once. offsetWidth, which includes a classic
 * scrollbar, so the layout a threshold picks cannot change the scrollbar and
 * with it the width it was picked from.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** The root font size in px, which is what a `rem` threshold is worth right now. */
export function rootFontPx(): number {
  if (typeof document === "undefined") return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}
