import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * The in-progress service timeline (planned vs. actual per-item timing), pushed on
 * the "service-timeline:history" channel each time an item changes. Hydrates once
 * from the current record, then stays live. Backs the "Service pacing" layout
 * object's whole-service scope. Returns null when nothing is recording yet.
 */
export function useServiceTimeline(): ServiceTimeline | null {
  const [timeline, setTimeline] = useState<ServiceTimeline | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<ServiceTimeline | null>("serviceTimeline:getCurrent")
      .then((t) => {
        if (!cancelled) setTimeline(t ?? null);
      })
      .catch(() => {
        /* not recording yet — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onNotification("service-timeline:history", (p) => setTimeline((p as ServiceTimeline | null) ?? null));
  }, []);

  return timeline;
}
