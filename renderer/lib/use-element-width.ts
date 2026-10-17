import { useLayoutEffect, useState, type RefObject } from "react";

/** The root font size in px, which is what a `rem` threshold is worth right now. */
function rootFontPx(): number {
  if (typeof document === "undefined") return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * Which of a set of widths an element has reached, as an index: 0 below every
 * width in `minRems`, 1 at the first, 2 at the second, and so on. `minRems` is
 * ascending.
 *
 * For a decision about how much ROOM a piece of the page has, which the window
 * width cannot answer: the same 1024px window has about 760px of page with the
 * sidebar open and about 930px with it collapsed. A media query cannot ask the
 * pane; `@container` can, but only for styling, and a layout that swaps one
 * component tree for another needs the answer in JS.
 *
 * Holds the tier, not the width: a sidebar drag or the collapse animation
 * resizes the pane every frame, and the answer changes at most a few times, so
 * only a change of tier renders the page again.
 *
 * Measured before the first paint, so a page that opens wide never flashes the
 * narrow layout. 0 until the element mounts, and in an environment with no
 * ResizeObserver it is measured once. Measures offsetWidth, which includes a
 * classic scrollbar, so the layout the answer picks cannot change the scrollbar
 * and with it the width the answer was picked from.
 */
export function useElementTier(ref: RefObject<HTMLElement | null>, minRems: readonly number[]): number {
  const [tier, setTier] = useState(0);
  // A new array each render must not restart the observer.
  const key = minRems.join(",");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rems = key.split(",").map(Number);
    const measure = () => {
      const px = el.offsetWidth;
      const unit = rootFontPx();
      setTier(rems.filter((r) => px >= r * unit).length);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, key]);
  return tier;
}
