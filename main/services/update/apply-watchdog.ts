// apply-watchdog.ts — noticing an update that has stopped happening.
//
// An apply is narrated by files the detached script writes: a progress step, a
// growing log, and finally a result. The UI leaves the "updating" phase when
// the result arrives — so a script that dies WITHOUT writing one leaves the
// page on "Downloading update… 20%" indefinitely, with no way to learn it is
// over. Observed on a real box: the script's working directory was deleted out
// from under it, every remaining command failed, and nothing wrote a result.
//
// The strategies now report their own failures, but that is exactly the kind of
// promise a watchdog exists to not depend on: the script can be killed, the box
// can be power-cycled mid-apply, a future strategy can have a path that exits
// without reporting. This bounds ALL of them.
//
// "Stalled" is deliberately silence, not elapsed time. A slow download on a
// church DSL line is not a failure, and a 20-minute apply that is still writing
// to its log must never be declared dead.

/** No progress file change, no log growth, no result, for this long → dead. */
export const STALL_TIMEOUT_MS = 10 * 60 * 1000;

export class ApplyWatchdog {
  private lastActivityAt = 0;

  /** Called when an apply starts. */
  begin(now: number): void {
    this.lastActivityAt = now;
  }

  /** Called on any sign of life: a new step, or the log growing. */
  progress(now: number): void {
    this.lastActivityAt = now;
  }

  /** True once the run has been silent long enough to call it dead. */
  stalled(now: number, timeoutMs: number = STALL_TIMEOUT_MS): boolean {
    if (this.lastActivityAt === 0) return false; // no apply in flight
    return now - this.lastActivityAt >= timeoutMs;
  }

  /** Stop watching (the run ended, one way or another). */
  end(): void {
    this.lastActivityAt = 0;
  }

  /** How long the current silence has lasted, for the operator-facing message. */
  silentFor(now: number): string {
    const min = Math.round((now - this.lastActivityAt) / 60000);
    return min === 1 ? "1 minute" : `${min} minutes`;
  }
}
