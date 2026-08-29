// Which screens actually have a browser attached.
//
// The server has known this all along: display-presence.ts tracks a heartbeat
// per output with a 90s TTL and a sendBeacon on unload, and broadcasts the
// connected set on "displays:presence" only when it changes. Settings →
// Displays has been lighting a real dot from it.
//
// Home and the multiview tiles used `outputs.filter(o => o.viewId)` instead,
// which is ROUTED, not connected — so a screen that is routed and unplugged read
// as online for ever. On a producer wall that is the worst available lie: the
// one tile you need to notice is the one that looks fine.
//
// `enabled` is how a wall display avoids subscribing to something it does not
// draw, which was the objection that kept the fake in place. Same shape as every
// other gated channel in useLayoutData: `useObsState(want([...]))`.

import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/** Stable identity, so `enabled: false` does not hand a new array out per render. */
const EMPTY: readonly string[] = [];

interface PresenceDTO {
  connected?: string[];
}

/**
 * Output ids with a live heartbeat. Empty means "none, or we do not know" — the
 * safe direction: a dot that is dark invites a look at the screen, a dot that is
 * lit says there is nothing to look at.
 */
export function useDisplayPresence(enabled = true): readonly string[] {
  const [connected, setConnected] = useState<readonly string[]>(EMPTY);

  // Hydrate once on mount, exactly like useObsState. The SSE hello burst does
  // carry a presence snapshot and api.ts caches it for a late subscriber — but
  // only the CONNECT-time value. Between the burst and this hook mounting, the
  // server filters "displays:presence" out for a client with nothing subscribed
  // to it, so every change in that window is lost and the cached snapshot can be
  // hours old. Presence broadcasts only on change, so in a quiet building
  // nothing would ever correct it. Asking once is what makes the first paint
  // true rather than true-as-of-page-load.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<PresenceDTO>("displays:getPresence")
      .then((p) => {
        if (!cancelled) setConnected(p?.connected ?? EMPTY);
      })
      .catch(() => {
        // Deliberately swallowed, and the only place in this file that is.
        // Presence is ambient and self-correcting: the subscription below fixes
        // it on the next change, and there is nothing an operator can do about a
        // failed ambient read at page load — a toast on every wall display that
        // loads during a server restart is noise, not information. What matters
        // is that failing leaves the set EMPTY: "we do not know" reads as not
        // connected, never as connected, so a failure cannot manufacture the
        // reassurance this whole change exists to remove.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return onNotification("displays:presence", (p) => {
      setConnected((p as PresenceDTO | null)?.connected ?? EMPTY);
    });
  }, [enabled]);

  return enabled ? connected : EMPTY;
}
