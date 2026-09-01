import { useCallback, useState } from "react";

import { invoke } from "../lib/api";
import { useResyncOn } from "../lib/use-resync-on";
import { useStatusChannel } from "./use-status-channel";

/**
 * Live ProVideoPlayer layer state, pushed on the "pvp:status" channel. Hydrates
 * once over HTTP so a freshly-loaded display is not blank until the next change,
 * then lives on the broadcast.
 *
 * `enabled` is the gate the layout renderer uses, and it matters more here than
 * for most: the channel's demand is what decides the poll cadence at the other
 * end, so an ungated hook would hold PVP at 1 Hz for a screen showing a clock.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have.
 */
export function usePvpState(enabled = true): PvpStatusDTO | null {
  const read = useCallback(() => invoke<PvpStatusDTO>("pvp:getStatus"), []);
  return useStatusChannel<PvpStatusDTO>(read, "pvp:status", enabled);
}

/**
 * How far this browser's clock is behind the server's, measured from PVP's OWN
 * frames.
 *
 * The shared `skewMs` threaded through the layout renderer is derived solely
 * from `pcoLive.serverNow`, so with Planning Center unconfigured or unreachable
 * it stays 0 — and PVP's progress bar then compares a SERVER-stamped `sampledAt`
 * against the browser's clock. On a wall Pi a minute fast that pins every bar at
 * 100% and every countdown at 0:00, and the clamp in computePvpProgress makes
 * the wrong answer look like a legitimate one. Nothing about ProVideoPlayer
 * should depend on whether Planning Center is up.
 *
 * `sampledAt` is stamped as the poll returns and arrives within a broadcast of
 * being taken, so the moment a frame lands is a fair reading of the offset. Only
 * moved when a NEW sample arrives — re-measuring on every render would chase the
 * render loop rather than the clock.
 */
export function usePvpSkewMs(pvp: PvpStatusDTO | null): number {
  const [skewMs, setSkewMs] = useState(0);
  // useResyncOn, not an effect, and for the same reason the PCO skew uses it:
  // the reading must be taken when the frame ARRIVES. An effect runs a paint
  // later, so the offset would absorb however long the render took.
  useResyncOn([pvp?.sampledAt], () => {
    const serverMs = Date.parse(pvp?.sampledAt ?? "");
    if (Number.isFinite(serverMs)) setSkewMs(serverMs - Date.now());
  });
  return skewMs;
}
