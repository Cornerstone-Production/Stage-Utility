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

/**
 * Milliseconds since `key` last changed — a clock that starts at zero.
 *
 * For a preview, and it exists because the wall clock is the wrong clock here.
 * A preview positioned by `Date.now() % cycleMs` sits at an offset that has no
 * relation to the same clock modulo a DIFFERENT cycle length, so every press of
 * the duration stepper threw it onto an unrelated item and holding the stepper
 * flipped through the whole playlist. Reported as exactly that.
 *
 * Counting from zero, a duration edit re-times the cycle instead of scrubbing
 * it. A wall screen keeps the server's `startedAt`, which is what holds two real
 * screens in step; nothing in an editor preview needs that.
 *
 * The interval callback does the setting, not the effect body — the effect only
 * captures its own start, which is what keeps this out of a render loop.
 */
export function useElapsed(key: string | null, intervalMs: number): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - start), intervalMs);
    return () => clearInterval(t);
  }, [key, intervalMs]);
  return elapsed;
}
