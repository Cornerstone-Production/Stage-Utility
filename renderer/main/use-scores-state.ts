import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/**
 * Live followed-team scores, pushed on the "scores:status" channel. Hydrates
 * once on mount (the channel only broadcasts on change) then stays live. Shared
 * by the context-bar capsule, the Home card, the custom-layout "Live scores"
 * object and its editor inspector.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have. It matters more on
 * this channel than most: scoresChanged() gates the broadcast, so a read that
 * overwrites a newer push leaves the pre-goal score on screen until the next
 * scoring play.
 */
export function useScoresState(enabled = true): ScoresStatusDTO | null {
  const read = useCallback(() => invoke<ScoresStatusDTO>("scores:getStatus"), []);
  return useStatusChannel<ScoresStatusDTO>(read, "scores:status", enabled);
}
