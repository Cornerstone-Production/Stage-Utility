import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Live REAPER transport state, pushed on the "reaper:status" channel. Hydrates
 * once on mount (the channel only broadcasts on change) then stays live. Shared
 * by the custom-layout "REAPER status" object and its editor inspector.
 */
export function useReaperState(enabled = true): ReaperStatusDTO | null {
  const [reaper, setReaper] = useState<ReaperStatusDTO | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<ReaperStatusDTO>("reaper:getStatus")
      .then((s) => {
        if (!cancelled && s) setReaper(s);
      })
      .catch(() => {
        /* not configured yet — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return onNotification("reaper:status", (p) => setReaper(p as ReaperStatusDTO));
  }, [enabled]);

  return reaper;
}
