import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Live ProVideoPlayer layer state, pushed on the "pvp:status" channel. Hydrates
 * once over HTTP so a freshly-loaded display is not blank until the next change,
 * then lives on the broadcast.
 *
 * `enabled` is the gate the layout renderer uses, and it matters more here than
 * for most: the channel's demand is what decides the poll cadence at the other
 * end, so an ungated hook would hold PVP at 1 Hz for a screen showing a clock.
 */
export function usePvpState(enabled = true): PvpStatusDTO | null {
  const [pvp, setPvp] = useState<PvpStatusDTO | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<PvpStatusDTO>("pvp:getStatus")
      .then((s) => {
        if (!cancelled && s) setPvp(s);
      })
      .catch(() => {
        // A failed hydrate is not an error state: the next broadcast fills it in,
        // and the Integrations panel is where a connection problem is reported.
        // Nothing is swallowed here that anyone could act on.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return onNotification("pvp:status", (p) => setPvp(p as PvpStatusDTO));
  }, [enabled]);

  return pvp;
}
