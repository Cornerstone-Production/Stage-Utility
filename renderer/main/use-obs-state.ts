import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/**
 * Live OBS output state, pushed on the "obs:status" channel. Hydrates once on
 * mount (the channel only broadcasts on change) then stays live. Shared by the
 * custom-layout "OBS status" object and its editor inspector.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have.
 */
export function useObsState(enabled = true): ObsStatusDTO | null {
  const read = useCallback(() => invoke<ObsStatusDTO>("obs:getStatus"), []);
  return useStatusChannel<ObsStatusDTO>(read, "obs:status", enabled);
}
