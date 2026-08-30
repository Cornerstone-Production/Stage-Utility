// score-activity-store.ts — whether the activity is open, and which card has focus.
//
// A module-level store rather than state threaded through BarItemContext.
//
// renderBarItem is a pure (id, ctx) => ReactNode and context-bar.test.tsx asserts
// it never returns null for any id. Putting open/focus state into the context
// object every item reads would put UI state in a data structure whose whole job
// is to carry readings. This is the same shape toast.tsx already uses, and it is
// why toast.x() works from non-React modules.
//
// It is built by a FACTORY with one exported instance, rather than as bare module
// state. The three rules worth guarding here — one score opens the panel once, a
// hand-driven toggle cancels the hold, seed never opens — are all about a store
// that has never been touched before, and module state cannot be returned to that
// condition between tests. The alternative is a reset() hatch nothing in the app
// calls, or tests that only pass in the order they were written. Neither is a
// guard. `createScoreActivity()` gives each test its own store and gives the app
// exactly one.

import { useSyncExternalStore } from "react";

export interface ScoreActivityState {
  open: boolean;
  /** Index into the games list. 0 when only one game is followed. */
  focus: number;
  /** The rev the panel last auto-opened for, so one score opens it once. */
  seenRev: number;
}

/** How long an auto-opened activity stays up before folding away by itself. */
export const SCORE_HOLD_MS = 6500;

export interface ScoreActivityStore {
  subscribe(fn: () => void): () => void;
  get(): ScoreActivityState;
  /**
   * Open or close by hand.
   *
   * A hand-driven open OWNS the panel from that moment: it cancels any hold left
   * over from a score, so a tap to dismiss is never undone two seconds later by
   * a timer the operator cannot see.
   */
  toggle(): void;
  close(): void;
  focus(i: number): void;
  /**
   * A score arrived. Opens, and folds away on its own.
   *
   * Guarded on `rev` so one score opens it once: the DTO is re-delivered to every
   * late SSE subscriber from the hello burst, and without this a page opened five
   * minutes after a touchdown would pop the panel as if it had just happened.
   */
  scored(rev: number, focus: number): void;
  /**
   * Seed `seenRev` without opening — used on first mount so a page loaded long
   * after a score does not animate a stale one.
   */
  seed(rev: number): void;
}

export function createScoreActivity(): ScoreActivityStore {
  let state: ScoreActivityState = { open: false, focus: 0, seenRev: 0 };
  const subscribers = new Set<() => void>();
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function publish(next: ScoreActivityState): void {
    state = next;
    // A copy, so a subscriber that subscribes or unsubscribes while being
    // notified cannot change what this pass visits. NOT because a live Set
    // iterator would skip an entry -- it would not, and a test written on that
    // claim passed with the copy removed, which is a guard that cannot fail.
    // It is here for the weaker, true reason: one deterministic pass per publish.
    for (const fn of [...subscribers]) fn();
  }

  function clearHold(): void {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  }

  return {
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    get() {
      return state;
    },
    toggle() {
      clearHold();
      publish({ ...state, open: !state.open });
    },
    close() {
      clearHold();
      publish({ ...state, open: false });
    },
    focus(i) {
      clearHold();
      publish({ ...state, focus: i, open: true });
    },
    scored(rev, focus) {
      if (rev === state.seenRev) return;
      clearHold();
      publish({ open: true, focus, seenRev: rev });
      holdTimer = setTimeout(() => publish({ ...state, open: false }), SCORE_HOLD_MS);
    },
    seed(rev) {
      if (state.seenRev === 0) publish({ ...state, seenRev: rev });
    },
  };
}

/** The one the app uses. */
export const scoreActivity = createScoreActivity();

export function useScoreActivity(): ScoreActivityState {
  return useSyncExternalStore(scoreActivity.subscribe, scoreActivity.get, scoreActivity.get);
}
