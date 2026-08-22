// use-now.ts — a clock as state, so render stays pure.
//
// Reading Date.now() during render is impure: two renders of the same props can
// disagree, and React may re-render at any time. Every signage surface that has
// to answer "which entry is current" needs a clock, so it is one hook rather
// than a Date.now() sprinkled through each of them.

import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs`.
 *
 * Pick the interval from what the surface actually shows. The player needs a
 * tenth of a second because a transition is 600ms; a board that marks which
 * schedule is winning is happy with seconds.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
