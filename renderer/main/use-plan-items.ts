import { useCallback, useEffect, useRef, useState } from "react";

import { invoke, onNotification } from "../lib/api";

export interface PlanItemsStatus {
  /** The rundown, kept across a failed refetch of the SAME plan so a blip does
   *  not blank a list that was right a moment ago. Never another plan's: see
   *  the plan-change note below. null until a read has succeeded. */
  value: PlanItemsDTO | null;
  /** Whether a read for the current plan has answered, success or failure.
   *  Before that `null` is "not asked yet", which a surface must not draw as
   *  "no plan". */
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
 *
 * A plan change drops the rundown it held unless that rundown is already the
 * new plan's. Kept, plan A's items read as plan B's for the length of B's read,
 * and for good if that read failed, with nothing on screen to say so — the rule
 * script-view-plan-switch.test.tsx holds ScriptView to, where showing the wrong
 * plan was worse than showing nothing. Only the latest read may land, so a slow
 * answer for the plan just left cannot overwrite the one for the plan now live.
 *
 * @param enabled false where nothing on screen draws it — a layout with no
 *   service-order or pacing widget. Off, it reads nothing. Gated in the fetch
 *   rather than around the listener, because the read is all this costs: the
 *   stage state channel is held open by every surface that renders a layout,
 *   and keeping the listener tracks the plan while off, so switching back on
 *   reads once rather than again for a plan it has already seen.
 */
export function usePlanItemsStatus(enabled = true): PlanItemsStatus {
  const [answer, setAnswer] = useState<{ value: PlanItemsDTO | null; failed: boolean } | null>(null);
  const planRef = useRef<string | null | undefined>(undefined);
  const latest = useRef(0);

  const fetchItems = useCallback(() => {
    if (!enabled) return;
    const mine = ++latest.current;
    invoke<PlanItemsDTO>("pco:getPlanItems")
      .then((d) => {
        if (mine === latest.current) setAnswer({ value: d, failed: false });
      })
      .catch(() => {
        if (mine === latest.current) setAnswer((prev) => ({ value: prev?.value ?? null, failed: true }));
      });
  }, [enabled]);

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
      if (pid === planRef.current) return;
      planRef.current = pid;
      if (replayed) return;
      // Kept only when it already IS this plan's: the mount read racing the
      // first push answers for the plan that push names.
      setAnswer((prev) => (prev && !prev.failed && prev.value?.planId === pid ? prev : null));
      fetchItems();
    });
  }, [fetchItems]);

  return answer ? { value: answer.value, known: true, failed: answer.failed } : UNKNOWN;
}

/** The rundown alone, for callers that draw nothing from a missing one — the
 *  baptism triggers panel hides, and the inspector says what appears once a
 *  plan is loaded. */
export function usePlanItems(enabled = true): PlanItemsDTO | null {
  return usePlanItemsStatus(enabled).value;
}
