import { useLayoutEffect, useState, type RefObject } from "react";

/** The root font size in px, which is what a `rem` threshold is worth right now. */
function rootFontPx(): number {
  if (typeof document === "undefined") return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * Whether an element is at least `minRem` wide, kept current as it resizes.
 *
 * For a decision about how much ROOM a piece of the page has, which the window
 * width cannot answer: the same 1024px window has about 760px of page with the
 * sidebar open and about 930px with it collapsed. A media query cannot ask the
 * pane; `@container` can, but only for styling, and a layout that swaps one
 * component tree for another needs the answer in JS.
 *
 * Holds the boolean, not the width: a sidebar drag or the collapse animation
 * resizes the pane every frame, and the answer changes once, so only that one
 * change renders the page again.
 *
 * Measured before the first paint, so a page that opens wide never flashes the
 * narrow layout. False until the element mounts, and in an environment with no
 * ResizeObserver it is measured once. Measures offsetWidth, which includes a
 * classic scrollbar, so the layout the answer picks cannot change the scrollbar
 * and with it the width the answer was picked from.
 */
export function useElementAtLeastRem(ref: RefObject<HTMLElement | null>, minRem: number): boolean {
  const [atLeast, setAtLeast] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setAtLeast(el.offsetWidth >= minRem * rootFontPx());
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, minRem]);
  return atLeast;
}
