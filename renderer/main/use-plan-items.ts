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
    return onNotification("stage:state-changed", (p) => {
      const pid = (p as StageState | null)?.planId ?? null;
      if (pid !== planRef.current) {
        planRef.current = pid;
        fetchItems();
      }
    });
  }, [fetchItems]);

  return items;
}
