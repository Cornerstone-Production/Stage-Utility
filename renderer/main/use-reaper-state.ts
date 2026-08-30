import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/**
 * Live REAPER transport state, pushed on the "reaper:status" channel. Hydrates
 * once on mount (the channel only broadcasts on change) then stays live. Shared
 * by the custom-layout "REAPER status" object and its editor inspector.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have.
 */
export function useReaperState(enabled = true): ReaperStatusDTO | null {
  const read = useCallback(() => invoke<ReaperStatusDTO>("reaper:getStatus"), []);
  return useStatusChannel<ReaperStatusDTO>(read, "reaper:status", enabled);
}
