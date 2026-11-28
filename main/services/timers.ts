// timers.ts — clearing a timer held in a nullable field, and how long to wait
// before the next try.

/** Clears `timer` if one is set, and returns null to store in its place:
 *  `this.retryTimer = cleared(this.retryTimer)`. */
export function cleared(timer: NodeJS.Timeout | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

/**
 * How long to wait after `failures` failures in a row: `minMs`, doubling per
 * failure, never past `maxMs`.
 *
 * The one doubling formula. Each caller keeps its own policy (the first wait,
 * the ceiling, any jitter, a window-aware clamp on top) and passes it in; what
 * used to drift was the arithmetic itself, written out nine ways with the index
 * starting at 0 in some and 1 in others. This one counts failures from 1, so a
 * caller holding a 0-based attempt passes `attempt + 1`.
 *
 * `maxMs` defaults to no ceiling, for a caller whose clamp is applied after.
 */
export function backoffMs(failures: number, minMs: number, maxMs = Infinity): number {
  return Math.min(maxMs, minMs * 2 ** Math.max(0, failures - 1));
}

/** A trailing throttle: `schedule()` marks work pending and, if no wait is running,
 *  starts one; when it ends, `flush` runs once for however many `schedule()` calls
 *  came in. `cancel()` drops the wait and the pending mark (a caller that publishes
 *  at once has nothing left to flush). */
export interface Trailing {
  /** Marks work pending. Returns true when it started the wait, false when one was already running. */
  schedule(): boolean;
  cancel(): void;
}

/** A burst of readings becomes one `flush` every `ms` at most, carrying the last. */
export function trailing(ms: number, flush: () => void): Trailing {
  let timer: NodeJS.Timeout | null = null;
  let dirty = false;
  return {
    schedule(): boolean {
      dirty = true;
      if (timer) return false;
      timer = setTimeout(() => {
        timer = null;
        if (!dirty) return;
        dirty = false;
        flush();
      }, ms);
      return true;
    },
    cancel(): void {
      timer = cleared(timer);
      dirty = false;
    },
  };
}
