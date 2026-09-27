import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel, type StatusChannelResult } from "./use-status-channel";

/**
 * Live OBS output state, pushed on the "obs:status" channel, plus whether it
 * has answered yet. Hydrates once on mount (the channel only broadcasts on
 * change) then stays live. Shared by the custom-layout OBS, recorder and
 * streaming widgets, their editor inspector, Home's recording/streaming cards
 * and the context bar — all but the inspector judge "connected" from `value`,
 * and must not say "not connected" before `known` is true. See
 * useStatusChannel's own header.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have.
 */
export function useObsStatus(enabled = true): StatusChannelResult<ObsStatusDTO> {
  const read = useCallback(() => invoke<ObsStatusDTO>("obs:getStatus"), []);
  return useStatusChannel<ObsStatusDTO>(read, "obs:status", enabled);
}

/** The value alone, for the editor inspector's live-status line. */
export function useObsState(enabled = true): ObsStatusDTO | null {
  return useObsStatus(enabled).value;
}
