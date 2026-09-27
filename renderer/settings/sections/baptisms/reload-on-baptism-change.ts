// reload-on-baptism-change.ts — the one place that decides "a baptism session
// list needs reloading", shared by the Baptisms tab (baptism-operator.tsx) and
// History (service-history-section.tsx). Both hold their OWN copy of a
// sessions list and must refetch it when a session finishes or a Rebuild
// touches the store, from ANY of the places that can do that: this page's own
// buttons, a second tab, the display's operator panel, or Companion's
// baptism.advance/baptism.finish automation actions. Before this existed,
// BaptismOperator only reacted to its own Finish button, so a finish from any
// of those other places left its Past sessions and Trends cards stale until a
// full reload — the exact bug this closes.
//
// A plain subscribe function, not a custom hook: each caller's own effect
// still owns ITS OWN fetch (with its own cancellation guard and dependency
// list — service-history-section.tsx's fetch is also keyed on `reloadKey` and
// `selectedKey`, baptism-operator.tsx's is not), so wrapping this in its own
// `useEffect` would either drop that guard or force both callers onto one
// dependency shape. What both need identically is only the "when" —
// subscribing to the same two channels and deciding when a push is worth
// acting on — so that is the one thing lifted out.

import { onNotification } from "../../../lib/api";

/**
 * Call `reload` whenever a baptism session finished or a Rebuild changed the
 * store, ignoring replayed (connect-time cache) frames and pushes that carry
 * no real change. Returns an unsubscribe function — call it from an effect's
 * own cleanup.
 *
 * `baptism:state` is live far more often than a session finishes (every
 * second while a timer runs), so a push is only acted on when its
 * `[finishedAt, saveErrors]` pair actually changed since the last one seen —
 * a session finishing, or a save-failure entry clearing via a Rebuild done
 * elsewhere. `baptism:rebuilt` reloads unconditionally: it can add, update or
 * restore a session with no `baptism:state` change to key off at all.
 */
export function reloadOnBaptismChange(reload: () => void): () => void {
  let lastSignature: string | null = null;
  const offState = onNotification("baptism:state", (payload, replayed) => {
    if (replayed) return;
    const state = payload as BaptismState;
    const signature = JSON.stringify([state.finishedAt, state.saveErrors ?? null]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    reload();
  });
  const offRebuilt = onNotification("baptism:rebuilt", (_payload, replayed) => {
    if (replayed) return;
    reload();
  });
  return () => {
    offState();
    offRebuilt();
  };
}
