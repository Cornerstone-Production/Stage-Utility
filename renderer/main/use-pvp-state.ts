import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useServerClockSample } from "../lib/server-clock";
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
  const status = useStatusChannel<PvpStatusDTO>(read, "pvp:status", enabled);
  // PVP's frames feed the page's clock like every other server-stamped
  // timestamp. `sampledAt` is stamped as the poll returns, so a landing frame is
  // a fair reading of the offset — and it means nothing about ProVideoPlayer
  // depends on whether Planning Center is up. That was the whole argument for
  // the second, PVP-only skew estimate this replaces: with PCO unconfigured the
  // shared estimate stayed 0, and every PVP bar compared a SERVER-stamped
  // `sampledAt` against the browser's clock. On a wall Pi a minute fast that
  // pins every bar at 100% and every countdown at 0:00, and the clamp in
  // computePvpProgress makes the wrong answer look legitimate. One clock fed by
  // both sources answers it without a second copy of the arithmetic.
  useServerClockSample(status?.sampledAt);
  return status;
}
