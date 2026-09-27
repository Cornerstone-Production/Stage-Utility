// use-failed-reads.ts — which of a component's reads FAILED, as opposed to came
// back empty.
//
// A failed read drawn as its empty result says something false about a system
// that is fine — "no saved groups", "connect Planning Center" — and puts nothing
// on /log. `fail` does both halves at once: it records the read, so the
// component can draw an ErrorNote where the empty state would have been, and it
// logs one line on the component's tag. `clear` is for the read that later
// succeeds, so a note never outlives its failure.

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { logReadFailure } from "./client-log";

const NONE: ReadonlySet<never> = new Set();

export interface FailedReads<K extends string> {
  /** The reads that failed and have not succeeded since. */
  failed: ReadonlySet<K>;
  /** Record `which` as failed, and log it — once per failure streak, so a read
   *  retried on a timer says so when it starts failing, not every tick. */
  fail: (which: K, what: string, err: unknown) => void;
  /** `which` succeeded, or no longer applies. No argument clears every read.
   *  Safe to call while rendering (from useResyncOn): it only sets state. */
  clear: (...which: K[]) => void;
}

/** Both callbacks are stable, so an effect can close over them freely. */
export function useFailedReads<K extends string>(tag: string): FailedReads<K> {
  const [failed, setFailed] = useState<ReadonlySet<K>>(NONE);
  // What this failure streak has already logged. Written by `fail`, which a
  // promise callback calls and a render never does — so two failures before a
  // commit (StrictMode's doubled effects, or two reads failing together) still
  // write one line. `clear` does not touch it: it may run mid-render.
  const logged = useRef(new Set<K>());
  // Once a commit has taken a read out of `failed`, its next failure is a new
  // streak and worth a line again.
  useLayoutEffect(() => {
    for (const k of logged.current) if (!failed.has(k)) logged.current.delete(k);
  }, [failed]);
  const fail = useCallback(
    (which: K, what: string, err: unknown) => {
      if (!logged.current.has(which)) {
        logged.current.add(which);
        logReadFailure(tag, what, err);
      }
      setFailed((prev) => (prev.has(which) ? prev : new Set(prev).add(which)));
    },
    [tag],
  );
  const clear = useCallback((...which: K[]) => {
    setFailed((prev) => {
      const gone = which.length ? which.filter((k) => prev.has(k)) : [...prev];
      if (gone.length === 0) return prev;
      const next = new Set(prev);
      for (const k of gone) next.delete(k);
      return next;
    });
  }, []);
  return { failed, fail, clear };
}
