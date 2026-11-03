// A trailing-edge debounce for a value that changes faster than it should be saved.
//
// The colour wheel commits from onPointerMove, unthrottled. Writing each of those
// persisted to disk, rebuilt and broadcast state to every display. Only where the
// pointer STOPS is wanted, and it must not be lost: a value still pending when the
// component unmounts is committed then, not dropped with the timer.

import { useCallback, useEffect, useRef } from "react";

/** How long to wait again while `waitWhile` says a save is still running. */
const WAIT_RETRY_MS = 250;

export interface TrailingCommitContext {
  /** True when the commit is the unmount's flush, not the timer's. */
  unmounting: boolean;
}

/**
 * Returns `schedule(value)`: commit `value` after `ms` of quiet, replacing any value
 * still waiting. While `waitWhile()` is true the commit waits (a commit landing during a
 * save would otherwise be dropped or race it). Unmounting flushes what is pending at once.
 *
 * `onCommit` and `waitWhile` are read at fire time through a ref, so a parent handing
 * down a new function each render neither flushes early nor commits through a stale one.
 */
export function useTrailingCommit<T>(
  onCommit: (value: T, ctx: TrailingCommitContext) => void,
  ms: number,
  options: { waitWhile?: () => boolean } = {},
): (value: T) => void {
  const live = useRef({ onCommit, waitWhile: options.waitWhile });
  useEffect(() => {
    live.current = { onCommit, waitWhile: options.waitWhile };
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Boxed, so a pending `undefined` or `null` is still a pending value.
  const pending = useRef<{ value: T } | null>(null);

  /** Wait `delay`, then commit, or wait again while a save is running. */
  const arm = useCallback((delay: number) => {
    timer.current = setTimeout(function fire() {
      timer.current = null;
      if (!pending.current) return;
      if (live.current.waitWhile?.()) {
        timer.current = setTimeout(fire, WAIT_RETRY_MS);
        return;
      }
      const { value } = pending.current;
      pending.current = null;
      live.current.onCommit(value, { unmounting: false });
    }, delay);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const box = pending.current;
      pending.current = null;
      if (box) live.current.onCommit(box.value, { unmounting: true });
    },
    [],
  );

  return useCallback(
    (value: T) => {
      pending.current = { value };
      if (timer.current) clearTimeout(timer.current);
      arm(ms);
    },
    [arm, ms],
  );
}
