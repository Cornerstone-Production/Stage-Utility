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

import { useEffect, useRef, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/** Stable identity, so `enabled: false` does not hand a new array out per render. */
const EMPTY: readonly string[] = [];

interface PresenceDTO {
  connected?: string[];
  /** Which broadcast this set belongs to — see display-presence.ts. */
  rev?: number;
}

/**
 * Output ids with a live heartbeat. Empty means "none, or we do not know" — the
 * safe direction: a dot that is dark invites a look at the screen, a dot that is
 * lit says there is nothing to look at.
 */
export function useDisplayPresence(enabled = true): readonly string[] {
  const [connected, setConnected] = useState<readonly string[]>(EMPTY);

  // The newest revision this hook has applied, so two deliveries of the same
  // truth can be ordered. -1 means nothing has arrived yet.
  const appliedRev = useRef(-1);

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
    // A fresh read must beat whatever this hook applied on a previous enable.
    appliedRev.current = -1;
    invoke<PresenceDTO>("displays:getPresence")
      .then((p) => {
        if (cancelled) return;
        // Ordered by revision, NOT by arrival. A broadcast that lands while this
        // read is in flight is newer than the set the read was computed from, and
        // last-write-wins would overwrite it with the older one — then leave it
        // wrong until the next change, which on this channel can be hours.
        //
        // A bare "has anything been pushed?" flag cannot do this job: api.ts
        // REPLAYS the cached hello-burst payload to every late subscriber, so
        // one push always arrives — carrying the connect-time value that this
        // read exists to correct. The revision separates the replay (older) from
        // a live broadcast (newer); a payload with no revision at all can only
        // come from a server older than this bundle, where the old
        // last-write-wins behaviour is the safe fallback.
        if ((p?.rev ?? Number.POSITIVE_INFINITY) < appliedRev.current) return;
        if (typeof p?.rev === "number") appliedRev.current = p.rev;
        setConnected(p?.connected ?? EMPTY);
      })
      .catch(() => {
        // Deliberately swallowed, and the only place in this file that is.
        // Presence is ambient and self-correcting: the subscription below fixes
        // it on the next change, and there is nothing an operator can do about a
        // failed ambient read at page load — a toast on every wall display that
        // loads during a server restart is noise, not information.
        //
        // It CLEARS rather than leaving what was there. On a first mount the set
        // is already empty, but on an `enabled` false→true flip the previous
        // set would otherwise persist and render as lit — screens reported
        // Connected on the strength of a read that just failed, which is the
        // exact class of lie this hook exists to remove. Empty is the honest
        // reading of "we do not know", and it fails toward "go and look at the
        // screen" rather than toward reassurance.
        if (!cancelled) setConnected(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return onNotification("displays:presence", (p) => {
      const d = p as PresenceDTO | null;
      // A push is always at least as new as anything already applied.
      appliedRev.current = d?.rev ?? appliedRev.current + 1;
      setConnected(d?.connected ?? EMPTY);
    });
  }, [enabled]);

  return enabled ? connected : EMPTY;
}
