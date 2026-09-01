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

/**
 * The read in flight, and the plan it is for.
 *
 * The TOKEN is a request number, not the plan id, because `checklist:get` takes
 * no plan argument — every read is the same request to the same URL, so a plan
 * id cannot tell two of them apart. Keyed on the plan, A → B → A with nothing
 * cached puts three reads in flight and the token belongs to the third: the
 * FIRST then matches, clears the token and publishes, and the third is dropped
 * as stale. If that first answer describes a plan that is no longer selected,
 * `fresh` refuses its rows, `error` is null so nothing says why, and no effect
 * re-runs to try again — every widget on the page wedged at once, which is the
 * risk a single shared store carries that per-consumer state did not.
 */
let readSeq = 0;
let inFlightRead: { seq: number; planId: string } | null = null;

/**
 * Which write is the newest FOR A GIVEN ROW, so an older answer cannot overwrite
 * it.
 *
 * Two quick taps on one row are two requests, and nothing guarantees the first
 * resolves first. Without this the row can settle on the FIRST tap's result and
 * disagree with what is on disk until the next fetch — a checkbox that reads the
 * opposite of what was saved.
 *
 * PER ROW, not one counter for the store. `pending` is keyed per row, so a
 * single counter makes two ticks on DIFFERENT rows collide: the second bumps the
 * counter, and when the first resolves its cleanup sees a newer sequence and
 * never removes its own optimistic value. Tick CO2, tick Batteries, and let the
 * CO2 save fail — the toast says it did not save and the box stays ticked for
 * the life of the page, which is precisely the "silently kept locally" outcome
 * this file's header says the optimism must never produce.
 */
const writeSeq = new Map<string, number>();

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
 *
 * ONE READ PER PLAN, not one per mount, and that is a trade worth stating. A
 * nine-tile wall used to issue nine identical `checklist:get`s; it now issues
 * one. The cost is that a consumer mounting later no longer pulls a fresh copy,
 * so a note edited in Planning Center after the page loaded is not picked up
 * until the plan changes or the page reloads. There is no live channel to fix
 * that with — history-routes exposes GET and POST and broadcasts nothing — and
 * the old per-mount refetch only ever helped a surface that happened to mount
 * late.
 *
 * A FAILED read is the exception: `error` is left set, so the guard below does
 * not short-circuit and the next consumer to mount tries again. Same shape as
 * useStageState's retry-on-new-subscriber, and for the same reason — a server
 * that was down at page load must not blank the wall for ever.
 */
function ensure(planId: string | null): void {
  if (!planId || inFlightRead?.planId === planId) return;
  if (snapshot.data?.planId === planId && !snapshot.error) return;
  const seq = ++readSeq;
  inFlightRead = { seq, planId };
  invoke<PlanChecklistDTO>("checklist:get")
    .then((d) => {
      if (inFlightRead?.seq !== seq) return;
      inFlightRead = null;
      publish({ data: d, pending: {}, error: null });
    })
    .catch((e: unknown) => {
      if (inFlightRead?.seq !== seq) return;
      inFlightRead = null;
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
  const seq = (writeSeq.get(key) ?? 0) + 1;
  writeSeq.set(key, seq);
  publish({ ...snapshot, pending: { ...snapshot.pending, [key]: done } });
  try {
    const next = await invoke<PlanChecklistDTO>("checklist:tick", { key, done });
    // Superseded for THIS row only. A tick on another row is not news about this
    // one, and treating it as such is what left a failed tick showing as saved.
    if (writeSeq.get(key) !== seq) return;
    publish({ ...snapshot, data: next, error: null });
  } catch (e) {
    // Rethrowing here would reach no one — this is a click handler. Reporting is
    // the contract instead: the box goes back to what the server has, and the
    // operator is told why, rather than being left with a tick that was never
    // saved. Unlike the read, a tick is something they just did, so it gets a
    // toast as well as the row snapping back.
    toast.error(`Could not save that tick: ${errorMessage(e)}`);
  } finally {
    // Only the newest write ON THIS ROW clears its optimistic value; an older
    // one finishing later must not un-hold the row the newest is still waiting
    // on. A write on a DIFFERENT row is not a reason to hold this one at all.
    if (writeSeq.get(key) === seq) {
      writeSeq.delete(key);
      const { [key]: _dropped, ...rest } = snapshot.pending;
      publish({ ...snapshot, pending: rest });
    }
  }
}

/** Test seam — drops the shared cache so cases cannot contaminate each other. */
export function __resetForTests(): void {
  snapshot = { data: null, pending: {}, error: null };
  subscribers.clear();
  inFlightRead = null;
  readSeq = 0;
  writeSeq.clear();
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
