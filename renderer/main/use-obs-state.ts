import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel, type StatusChannelResult } from "./use-status-channel";

/**
 * Live OBS output state, pushed on the "obs:status" channel, plus whether it
 * has answered yet. Hydrates once on mount (the channel only broadcasts on
 * change) then stays live. Shared by the custom-layout "OBS status" object,
 * its editor inspector, Home's recording/streaming cards and the context bar —
 * the last three judge "connected" from `value`, and must not say "not
 * connected" before `known` is true. See useStatusChannel's own header.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have.
 */
export function useObsStatus(enabled = true): StatusChannelResult<ObsStatusDTO> {
  const read = useCallback(() => invoke<ObsStatusDTO>("obs:getStatus"), []);
  return useStatusChannel<ObsStatusDTO>(read, "obs:status", enabled);
}

/** The value alone, for callers that do not need to tell "not yet known" apart
 *  from a settled falsy answer — the custom-layout object and its inspector,
 *  where a `null` placeholder either way is the intended first paint. */
export function useObsState(enabled = true): ObsStatusDTO | null {
  return useObsStatus(enabled).value;
}
