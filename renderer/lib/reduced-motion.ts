// reduced-motion.ts — does this viewer want motion at all?
//
// Its own module, and not part of use-slide-on-move, because the callers are
// not all hooks. drawer-drag and view-transition are plain utilities with no
// React in them, and importing a React hook module to ask a media query pulled
// `useCallback`, `useEffect` and a FLIP implementation along behind it.

/**
 * Asked here, in JS, and not left to the global CSS override: that rule cannot
 * reach an inline `style.transform`, which is what a FLIP writes. Read at the
 * moment of the move rather than cached, so changing the system setting takes
 * effect without a reload.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
