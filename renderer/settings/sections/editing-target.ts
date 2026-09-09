// Which board the slot editors are pointed at — and NOTHING the machine follows.
//
// The plan switcher moves the EDITOR. What the screens show is still decided on
// the Plan page and nowhere else; nothing in this file writes a plan, a service
// type, or any setting.
//
// ── Why a module store rather than component state ────────────────────────────
//
// Two separate components have to agree on the target: the switcher in the
// layout editor's toolbar, and the inline grid far below the canvas that re-seeds
// from it. Component state cannot be shared across that gap, so the target lives
// here and both read it.
//
// ── Why it is written to no storage, ever ────────────────────────────────────
//
// A new tab, or a reload, must open on the plan the machine is following. That is
// the state an operator arriving at a screen expects, and a target quietly
// restored from a previous session is how somebody edits last week's board
// believing it is this week's. So: no localStorage, no sessionStorage, no URL
// parameter. This module's variable dies with the tab, which is the whole design.

import { useCallback, useSyncExternalStore } from "react";

import { useStageState } from "../../main/use-stage-state";
import { sameTarget, type EditingTarget } from "./plan-switcher-step";

export type { EditingTarget } from "./plan-switcher-step";

/**
 * Where the operator has pointed the editor, or null for "follow the machine".
 *
 * Null rather than a copy of the machine's target: while it is null the editor
 * follows the plan forward on its own, which is what an operator who has not
 * touched the switcher wants during a service.
 */
let pinned: EditingTarget | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * A veto on moving the editor — "there are unsaved edits in this grid".
 *
 * Registered by whichever editor holds a buffer. Every switcher goes through
 * `requestEditingTarget`, so the question is asked once, in one place, however
 * the move was started.
 */
export type TargetGuard = () => Promise<boolean>;

const guards = new Map<string, TargetGuard>();

export function registerTargetGuard(id: string, guard: TargetGuard | null): void {
  if (guard) guards.set(id, guard);
  else guards.delete(id);
}

/**
 * Move the editor, asking every registered guard first.
 *
 * Resolves false when a guard refused — the caller leaves the switcher where it
 * was. Sequential, so two editors do not both raise a dialog.
 */
export async function requestEditingTarget(next: EditingTarget | null): Promise<boolean> {
  for (const guard of [...guards.values()]) {
    if (!(await guard())) return false;
  }
  pinned = next;
  emit();
  return true;
}

/** The pinned target with no questions asked. For tests and for teardown. */
export function __setEditingTargetForTests(next: EditingTarget | null): void {
  pinned = next;
  emit();
}

/** Everything a switcher and a slots editor need about the current target. */
export interface EditingTargetState {
  /** The board being edited. Falls back to the machine's own when unpinned. */
  target: EditingTarget;
  /** The plan the machine is following. */
  live: EditingTarget;
  /** True when the two are the same — the `live` badge, and Now is disabled. */
  onLive: boolean;
  /** Point the editor somewhere, subject to the unsaved-edits guards. */
  setTarget: (next: EditingTarget) => Promise<boolean>;
  /** Back to the machine's plan, and following it again. */
  goLive: () => Promise<boolean>;
}

export function useEditingTarget(): EditingTargetState {
  const { state } = useStageState();
  const pin = useSyncExternalStore(
    subscribe,
    () => pinned,
    // Server snapshot: nothing is pinned before the tab exists.
    () => null,
  );

  const live: EditingTarget = {
    serviceTypeId: state?.serviceTypeId ?? null,
    planId: state?.planId ?? null,
  };
  const target = pin ?? live;

  const setTarget = useCallback((next: EditingTarget) => requestEditingTarget(next), []);
  const goLive = useCallback(() => requestEditingTarget(null), []);

  return { target, live, onLive: sameTarget(target, live), setTarget, goLive };
}
