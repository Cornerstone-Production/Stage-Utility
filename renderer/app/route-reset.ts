// Clicking the rail item you are already on resets that route to its top view.
//
// The settings panel had this: `historyNonce` bumped when History was
// re-selected, remounting it so a drilled-in service went back to the list. It
// was listed as carried through both Phase 1a and 1b and then wasn't — the rail
// calls router.navigate() to the CURRENT path, which TanStack correctly treats
// as a no-op, so nothing remounted and the drill-down stayed open.
//
// A nonce rather than route state: the reset must not create a history entry
// (Back would then step through resets) and must not appear in the URL, which is
// a bookmarkable address for a wall display.

import { useEffect, useState } from "react";

const EVENT = "stage:reset-route";

/**
 * The app's one scrolling pane — the shell's `<main>`, which every route renders
 * inside.
 *
 * Named with an attribute rather than found by shape, and that is not cosmetic.
 * TanStack's scroll restoration identifies a scroller by deriving an `nth-child`
 * path when the element carries no `data-scroll-restoration-id`, and this
 * element's index MOVES: the page header renders nothing on a nested route, and
 * the scores panel adds a sibling when its bar item is on. Three selectors for
 * one element is three cache keys, so the same navigation behaved differently
 * depending on which page you left and what was on the bar.
 *
 * Exported as a constant so the three places that care — the element itself, the
 * router's reset list, and the remount below — cannot spell it three ways.
 */
export const PAGE_SCROLLER_ID = "page";
export const PAGE_SCROLLER_SELECTOR = `[data-scroll-restoration-id="${PAGE_SCROLLER_ID}"]`;

/**
 * Put the page pane back at the top.
 *
 * Not `window.scrollTo`: the document itself cannot scroll — `html`, `body` and
 * `#root` are all `overflow: hidden` (app.html) — so every scroll in the operator
 * app happens inside this one element, and a window-level reset is a no-op that
 * reads as a fix.
 */
export function scrollPageToTop(): void {
  const pane = document.querySelector(PAGE_SCROLLER_SELECTOR);
  if (!pane) return;
  // Assignment rather than `scrollTo`, which is the same thing the router's own
  // element restore does, and unlike `scrollTo` it exists everywhere the tests
  // run — jsdom has no `Element.prototype.scrollTo`, so a guard written over
  // this would have thrown rather than checked anything.
  pane.scrollTop = 0;
  pane.scrollLeft = 0;
}

/** Ask the currently-rendered route to go back to its top view. */
export function resetCurrentRoute(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * A value that changes whenever the active rail item is re-selected.
 *
 * Used as a `key` on route content, so React remounts it — which is most of the
 * behaviour: local state (which service is open, which tab) goes back to its
 * initial value without the route itself changing. The page's SCROLL position is
 * not local state to that subtree, so it is reset explicitly.
 */
export function useRouteResetKey(): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const onReset = () => {
      // The remount alone does NOT do this, and the docblock above used to claim
      // it did. The scroller is the shell's `<main>`, which sits OUTSIDE the
      // keyed subtree — it is what the key hangs inside, not something the key
      // rebuilds — so re-selecting the rail item you are already on rebuilt the
      // page and left it scrolled exactly where it was.
      scrollPageToTop();
      setKey((n) => n + 1);
    };
    window.addEventListener(EVENT, onReset);
    return () => window.removeEventListener(EVENT, onReset);
  }, []);
  return key;
}
