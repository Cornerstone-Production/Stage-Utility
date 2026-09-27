import { useCallback, useEffect, useRef, useState } from "react";

import { invoke, onNotification } from "../lib/api";

export interface PlanItemsStatus {
  /** The rundown, kept across a failed refetch so a blip does not blank a list
   *  that was right a moment ago. null until a read has succeeded. */
  value: PlanItemsDTO | null;
  /** Whether any read has answered, success or failure. Before that `null` is
   *  "not asked yet", which a surface must not draw as "no plan". */
  known: boolean;
  /** The latest read failed. Returned rather than swallowed: the server answers
   *  an unconfigured Planning Center with an EMPTY rundown, so a `null` after a
   *  read means the read went wrong, and "No service plan" over it sends
   *  somebody to fix a plan that is fine. The server logs why, as [pco]. */
  failed: boolean;
}

const UNKNOWN: PlanItemsStatus = { value: null, known: false, failed: false };

/**
 * The active plan's full rundown (items + note-category columns) for the script
 * and SPL-rundown dashboards, plus whether it has answered and whether the last
 * read failed. Fetches on mount, then refetches whenever the live plan changes
 * (a `stage:state-changed` with a different planId).
 */
export function usePlanItemsStatus(): PlanItemsStatus {
  const [status, setStatus] = useState<PlanItemsStatus>(UNKNOWN);
  const planRef = useRef<string | null | undefined>(undefined);

  const fetchItems = useCallback(() => {
    invoke<PlanItemsDTO>("pco:getPlanItems")
      .then((d) => setStatus({ value: d, known: true, failed: false }))
      .catch(() => setStatus((prev) => ({ value: prev.value, known: true, failed: true })));
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

  return status;
}

/** The rundown alone, for callers that draw nothing from a missing one — the
 *  baptism triggers panel hides, and the inspector says what appears once a
 *  plan is loaded. */
export function usePlanItems(): PlanItemsDTO | null {
  return usePlanItemsStatus().value;
}
