import { useCallback, useEffect, useRef, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * The active plan's full rundown (items + note-category columns) for the script
 * and SPL-rundown dashboards. Fetches on mount, then refetches whenever the live
 * plan changes (a `stage:state-changed` with a different planId).
 *
 * @param enabled false where nothing on screen draws it — a layout with no
 *   service-order or pacing widget. Off, it reads nothing. Gated in the fetch
 *   rather than around the listener, because the read is all this costs: the
 *   stage state channel is held open by every surface that renders a layout,
 *   and keeping the listener tracks the plan while off, so switching back on
 *   reads once rather than again for a plan it has already seen.
 */
export function usePlanItems(enabled = true): PlanItemsDTO | null {
  const [items, setItems] = useState<PlanItemsDTO | null>(null);
  const planRef = useRef<string | null | undefined>(undefined);

  const fetchItems = useCallback(() => {
    if (!enabled) return;
    invoke<PlanItemsDTO>("pco:getPlanItems")
      .then((d) => setItems(d))
      .catch(() => {
        /* not configured / no plan — ignore */
      });
  }, [enabled]);

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
