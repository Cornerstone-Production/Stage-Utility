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

/** Ask the currently-rendered route to go back to its top view. */
export function resetCurrentRoute(): void {
  window.dispatchEvent(new CustomEvent(EVENT));
}

/**
 * A value that changes whenever the active rail item is re-selected.
 *
 * Used as a `key` on route content, so React remounts it — which is the whole
 * behaviour: local state (which service is open, which tab, scroll position)
 * goes back to its initial value without the route itself changing.
 */
export function useRouteResetKey(): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const onReset = () => setKey((n) => n + 1);
    window.addEventListener(EVENT, onReset);
    return () => window.removeEventListener(EVENT, onReset);
  }, []);
  return key;
}
