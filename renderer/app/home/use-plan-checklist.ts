// The plan's checklist, and the one thing that makes ticking feel instant.
//
// A tick is a round trip: the server owns the store, and the write is awaited so
// that a failed save is a failed tick rather than one that looked done until the
// next restart. That is correct and it is also 60-200ms, which on a checkbox
// reads as a stuck control — so the box moves immediately and the server's
// answer replaces the guess when it lands.
//
// The optimism is NOT a second source of truth. It is one pending tick, dropped
// the moment the server answers, and dropped back to the server's version if the
// save fails. An operator who ticks a box and sees it un-tick knows the save did
// not happen; an operator whose tick was silently kept locally does not.

import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "../../lib/api";
import { errorMessage } from "@main/services/errors";
import { toast } from "../../components/ui";
import type { PlanChecklistDTO, PlanChecklistRow } from "@main/services/plan-note-checklist";
import { useStageState } from "../../main/use-stage-state";

export interface PlanChecklist {
  rows: PlanChecklistRow[];
  toggle: (key: string, done: boolean) => Promise<void>;
}

const EMPTY: PlanChecklistRow[] = [];

export function usePlanChecklist(): PlanChecklist {
  const { state } = useStageState();
  const planId = state?.planId ?? null;

  const [data, setData] = useState<PlanChecklistDTO | null>(null);
  // key -> the tick we are waiting on the server to confirm.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const alive = useRef(true);
  /**
   * Which write is the newest, so an older answer cannot overwrite it.
   *
   * Two quick taps on one row are two requests, and nothing guarantees the
   * first resolves first. Without this the row can settle on the FIRST tap's
   * result and disagree with what is on disk until the next fetch — a checkbox
   * that reads the opposite of what was saved.
   */
  const writeSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Refetch when the PLAN changes, which is also what makes last week's ticks
  // disappear: a new plan is a new set of keys, so nothing carries over.
  useEffect(() => {
    if (!planId) return;
    let current = true;
    invoke<PlanChecklistDTO>("checklist:get")
      .then((d) => { if (current) { setData(d); setPending({}); } })
      // A checklist that cannot be read is not worth a toast on every page load
      // — PCO may simply be unreachable — but it must not leave stale rows on
      // screen claiming to describe this plan. `fresh` below is what enforces
      // that, rather than clearing state here: clearing synchronously inside an
      // effect cascades a render, and the staleness check has to exist anyway
      // for the gap between the plan changing and the answer arriving.
      .catch(() => { if (current) setData({ planId, rows: [], unconfigured: false }); });
    return () => { current = false; };
  }, [planId]);

  const toggle = useCallback(async (key: string, done: boolean) => {
    const seq = ++writeSeq.current;
    setPending((p) => ({ ...p, [key]: done }));
    try {
      const next = await invoke<PlanChecklistDTO>("checklist:tick", { key, done });
      if (!alive.current || seq !== writeSeq.current) return;
      setData(next);
    } catch (e) {
      // Rethrowing here would reach no one — this is a click handler. Reporting
      // is the contract instead: the box goes back to what the server has, and
      // the operator is told why, rather than being left with a tick that was
      // never saved.
      toast.error(`Could not save that tick: ${errorMessage(e)}`);
    } finally {
      // Only the newest write clears the optimistic value; an older one
      // finishing later must not un-hold the row the newest is still waiting on.
      if (alive.current && seq === writeSeq.current) {
        setPending((p) => {
          const { [key]: _dropped, ...rest } = p;
          return rest;
        });
      }
    }
  }, []);

  // Only trust an answer that is ABOUT the plan currently selected. Between the
  // plan changing and its checklist arriving, the previous plan's rows are still
  // in state and would otherwise be drawn under the new plan's heading — with
  // last week's ticks on them.
  const fresh = data && data.planId === planId ? data : null;
  const rows = fresh?.rows ?? EMPTY;
  const withPending =
    Object.keys(pending).length === 0
      ? rows
      : rows.map((r) => (r.key in pending ? { ...r, done: pending[r.key] } : r));

  return { rows: withPending, toggle };
}
