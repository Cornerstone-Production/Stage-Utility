import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel, type StatusChannelResult } from "./use-status-channel";

/**
 * Live REAPER transport state, pushed on the "reaper:status" channel, plus
 * whether it has answered yet. Hydrates once on mount (the channel only
 * broadcasts on change) then stays live. Shared by the custom-layout "REAPER
 * status" object, its editor inspector and Home's recording card — the last
 * judges "connected" from `value`, and must not say "not connected" before
 * `known` is true. See useStatusChannel's own header.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have.
 */
export function useReaperStatus(enabled = true): StatusChannelResult<ReaperStatusDTO> {
  const read = useCallback(() => invoke<ReaperStatusDTO>("reaper:getStatus"), []);
  return useStatusChannel<ReaperStatusDTO>(read, "reaper:status", enabled);
}

/** The value alone, for callers that do not need to tell "not yet known" apart
 *  from a settled falsy answer — the custom-layout object and its inspector. */
export function useReaperState(enabled = true): ReaperStatusDTO | null {
  return useReaperStatus(enabled).value;
}
