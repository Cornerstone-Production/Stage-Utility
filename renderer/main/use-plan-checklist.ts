// The plan's checklist, shared by both widgets that draw one.
//
// Lives here rather than beside either caller because BOTH the Home card and the
// custom-layout checklist object read it. Two copies of "fetch, tick
// optimistically, reconcile" would drift the first time either was touched, and
// the reconciliation is the subtle part.
//
// ── ONE STORE, not one per consumer ────────────────────────────────────────
//
// The rows used to live in each hook's own useState, fetched on each hook's own
// mount. The STORE is shared — the server owns it, and both widgets write to the
// same rows — but the two mounted hooks were not, so a page carrying both held
// two copies of the same list that never spoke again after the first tick. Tick
// a row on the Home card and the checklist object beside it kept the old value
// for the life of the page, which is the exact opposite of what notes-objects.tsx
// tells the reader ("Ticking here shows there and the other way round, because
// there is one list and one store behind both").
//
// So the cache is module-level and read through useSyncExternalStore, the same
// shape use-stage-state.ts uses and for the same reasons: every consumer in a
// commit sees one snapshot, and a nine-tile wall pays for one `checklist:get`
// rather than nine.
//
// The store is started by the first subscriber and left running for the life of
// the page. It is not torn down when the last consumer unmounts — there is
// nothing to keep alive but a small object, and dropping it would make the next
// mount refetch what it already had.
//
// ── The one thing that makes ticking feel instant ──────────────────────────
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

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { toast } from "../components/ui";
import type { PlanChecklistDTO, PlanChecklistRow } from "@main/services/plan-note-checklist";
import { useStageState } from "./use-stage-state";

export interface PlanChecklist {
  rows: PlanChecklistRow[];
  /**
   * Why there are no rows, when the reason is a failure rather than an empty
   * list — null the rest of the time.
   *
   * The read used to be caught and turned into `{ rows: [], unconfigured: false }`,
   * which is a DTO asserting that this plan legitimately has zero rows. With
   * Planning Center unreachable the checklist object then drew "No plan notes
   * chosen — Settings, Plan", sending the operator to fix a setting that was
   * already correct while the real cause was never stated anywhere. A caller
   * that can tell the two apart can say which one it is; one that cannot has to
   * guess, and it guessed wrong.
   *
   * useStageState was given the same field in the same work, for the same
   * reason.
   */
  error: string | null;
  toggle: (key: string, done: boolean) => Promise<void>;
}

const EMPTY: PlanChecklistRow[] = [];

interface Snapshot {
  /** The plan the data below is ABOUT, which is not always the selected one. */
  data: PlanChecklistDTO | null;
  /** key -> the tick being waited on. */
  pending: Record<string, boolean>;
  error: string | null;
}

let snapshot: Snapshot = { data: null, pending: {}, error: null };
const subscribers = new Set<() => void>();

/** The plan a read is in flight for, so many mounting consumers issue one. */
let fetchingFor: string | null = null;

/**
 * Which write is the newest, so an older answer cannot overwrite it.
 *
 * Two quick taps on one row are two requests, and nothing guarantees the first
 * resolves first. Without this the row can settle on the FIRST tap's result and
 * disagree with what is on disk until the next fetch — a checkbox that reads the
 * opposite of what was saved. Module-level now rather than a ref, because the
 * two taps can land on two different mounted checklists.
 */
let writeSeq = 0;

function publish(next: Snapshot): void {
  snapshot = next;
  for (const notify of [...subscribers]) notify();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

const getSnapshot = (): Snapshot => snapshot;

/**
 * Read the checklist for `planId`, once, however many consumers ask.
 *
 * Refetching when the PLAN changes is also what makes last week's ticks
 * disappear: a new plan is a new set of keys, so nothing carries over.
 */
function ensure(planId: string | null): void {
  if (!planId || fetchingFor === planId) return;
  if (snapshot.data?.planId === planId && !snapshot.error) return;
  fetchingFor = planId;
  invoke<PlanChecklistDTO>("checklist:get")
    .then((d) => {
      if (fetchingFor !== planId) return;
      fetchingFor = null;
      publish({ data: d, pending: {}, error: null });
    })
    .catch((e: unknown) => {
      if (fetchingFor !== planId) return;
      fetchingFor = null;
      // REPORTED, not invented. No toast on a page load — Planning Center may
      // simply be unreachable and there is nothing an operator can do about it
      // from a wall — but the failure reaches every consumer as `error` so the
      // surface can say what is actually wrong instead of blaming a setting.
      //
      // `data` is left alone rather than cleared: `fresh` below already refuses
      // rows that are about a different plan, and a failed refresh of the plan
      // already on screen should not blank rows the operator is working through.
      //
      // Logged as well as returned, tagged, so a checklist that came up empty at
      // 9am on a Sunday has something behind it in the browser console rather
      // than only a sentence on a wall. useStageState logs its hydrate failure
      // the same way.
      console.warn("[plan-checklist] could not read the plan's notes", e);
      publish({ ...snapshot, pending: {}, error: errorMessage(e) });
    });
}

/**
 * Tick a row.
 *
 * Module-level, so the optimistic value and the server's answer land in the ONE
 * snapshot both widgets read: a tick on the Home card moves the checklist object
 * beside it in the same commit.
 */
async function toggleRow(key: string, done: boolean): Promise<void> {
  const seq = ++writeSeq;
  publish({ ...snapshot, pending: { ...snapshot.pending, [key]: done } });
  try {
    const next = await invoke<PlanChecklistDTO>("checklist:tick", { key, done });
    if (seq !== writeSeq) return;
    publish({ ...snapshot, data: next, error: null });
  } catch (e) {
    // Rethrowing here would reach no one — this is a click handler. Reporting is
    // the contract instead: the box goes back to what the server has, and the
    // operator is told why, rather than being left with a tick that was never
    // saved. Unlike the read, a tick is something they just did, so it gets a
    // toast as well as the row snapping back.
    toast.error(`Could not save that tick: ${errorMessage(e)}`);
  } finally {
    // Only the newest write clears the optimistic value; an older one finishing
    // later must not un-hold the row the newest is still waiting on.
    if (seq === writeSeq) {
      const { [key]: _dropped, ...rest } = snapshot.pending;
      publish({ ...snapshot, pending: rest });
    }
  }
}

/** Test seam — drops the shared cache so cases cannot contaminate each other. */
export function __resetForTests(): void {
  snapshot = { data: null, pending: {}, error: null };
  subscribers.clear();
  fetchingFor = null;
  writeSeq = 0;
}

export function usePlanChecklist(): PlanChecklist {
  const { state } = useStageState();
  const planId = state?.planId ?? null;
  const { data, pending, error } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    ensure(planId);
  }, [planId]);

  const toggle = useCallback((key: string, done: boolean) => toggleRow(key, done), []);

  return useMemo(() => {
    // Only trust an answer that is ABOUT the plan currently selected. Between
    // the plan changing and its checklist arriving, the previous plan's rows are
    // still in the store and would otherwise be drawn under the new plan's
    // heading — with last week's ticks on them.
    const fresh = data && data.planId === planId ? data : null;
    const rows = fresh?.rows ?? EMPTY;
    const withPending =
      Object.keys(pending).length === 0
        ? rows
        : rows.map((r) => (r.key in pending ? { ...r, done: pending[r.key] } : r));
    return { rows: withPending, error, toggle };
  }, [data, pending, planId, error, toggle]);
}
