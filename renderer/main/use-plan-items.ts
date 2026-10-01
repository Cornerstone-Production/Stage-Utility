import { useCallback, useEffect, useRef, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * The active plan's full rundown (items + note-category columns) for the script
 * and SPL-rundown dashboards. Fetches on mount, then refetches whenever the live
 * plan changes (a `stage:state-changed` with a different planId).
 */
export function usePlanItems(): PlanItemsDTO | null {
  const [items, setItems] = useState<PlanItemsDTO | null>(null);
  const planRef = useRef<string | null | undefined>(undefined);

  const fetchItems = useCallback(() => {
    invoke<PlanItemsDTO>("pco:getPlanItems")
      .then((d) => setItems(d))
      .catch(() => {
        /* not configured / no plan — ignore */
      });
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    // `stage:state-changed` is a hydrated channel (sse-channels.ts), so every
    // mount into an already-open SSE stream replays its cached frame — on top
    // of the `fetchItems()` mount effect above, that was a second, redundant
    // `pco:getPlanItems` on every open. A replay is at best as new as this
    // mount, which the effect above already covers, so it only seeds
    // `planRef` here; a plan change is worth a refetch only when it arrives
    // LIVE.
    return onNotification("stage:state-changed", (p, replayed) => {
      const pid = (p as StageState | null)?.planId ?? null;
      const changed = pid !== planRef.current;
      planRef.current = pid;
      if (changed && !replayed) fetchItems();
    });
  }, [fetchItems]);

  return items;
}
