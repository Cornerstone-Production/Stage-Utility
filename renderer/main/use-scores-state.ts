import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Live followed-team scores, pushed on the "scores:status" channel. Hydrates
 * once on mount (the channel only broadcasts on change) then stays live. Shared
 * by the context-bar capsule, the Home card, the custom-layout "Live scores"
 * object and its editor inspector.
 */
export function useScoresState(enabled = true): ScoresStatusDTO | null {
  const [scores, setScores] = useState<ScoresStatusDTO | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<ScoresStatusDTO>("scores:getStatus")
      .then((s) => {
        if (!cancelled && s) setScores(s);
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
    return onNotification("scores:status", (p) => setScores(p as ScoresStatusDTO));
  }, [enabled]);

  return scores;
}
