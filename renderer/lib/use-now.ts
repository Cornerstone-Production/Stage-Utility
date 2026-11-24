// use-now.ts — a clock a component re-reads on an interval, so text measured against "now"
// ("checked 4 s ago", which plans are still upcoming) moves on without a change of its own.

import { useEffect, useState } from "react";

/**
 * `clock()` now, and again every `everyMs`. Date.now by default: wall time, for a date. Pass
 * performance.now for an elapsed time, which a step of the host clock must not move. Always
 * ticking, so it is never more than one interval stale when something first reads it.
 */
export function useNow(everyMs: number, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const t = setInterval(() => setNow(clock()), everyMs);
    return () => clearInterval(t);
  }, [everyMs, clock]);
  return now;
}
