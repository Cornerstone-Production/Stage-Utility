import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Live OBS output state, pushed on the "obs:status" channel. Hydrates once on
 * mount (the channel only broadcasts on change) then stays live. Shared by the
 * custom-layout "OBS status" object and its editor inspector.
 */
export function useObsState(enabled = true): ObsStatusDTO | null {
  const [obs, setObs] = useState<ObsStatusDTO | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<ObsStatusDTO>("obs:getStatus")
      .then((s) => {
        if (!cancelled && s) setObs(s);
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
    return onNotification("obs:status", (p) => setObs(p as ObsStatusDTO));
  }, [enabled]);

  return obs;
}
