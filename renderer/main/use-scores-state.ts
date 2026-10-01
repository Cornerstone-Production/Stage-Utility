import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel, type StatusChannelResult } from "./use-status-channel";

/**
 * Live followed-team scores, pushed on the "scores:status" channel, plus
 * whether it has answered yet. Hydrates once on mount (the channel only
 * broadcasts on change) then stays live. Shared by the context-bar capsule,
 * the Home card, the custom-layout "Live scores" object and its editor
 * inspector.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have. It matters more on
 * this channel than most: scoresChanged() gates the broadcast, so a read that
 * overwrites a newer push leaves the pre-goal score on screen until the next
 * scoring play.
 */
export function useScoresStatus(enabled = true): StatusChannelResult<ScoresStatusDTO> {
  const read = useCallback(() => invoke<ScoresStatusDTO>("scores:getStatus"), []);
  return useStatusChannel<ScoresStatusDTO>(read, "scores:status", enabled);
}

/** The value alone. `emptyReason`'s "No teams followed" for a `null` scores is
 *  a real answer once `known` — see useScoresStatus for the callers that must
 *  check it first. */
export function useScoresState(enabled = true): ScoresStatusDTO | null {
  return useScoresStatus(enabled).value;
}
