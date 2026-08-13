// repeat-log.ts — say it once, not once per poll.
//
// A poller that fails keeps failing: PCO credentials go stale and every tick
// writes the same line, 900 an hour at the live cadence. The /log buffer holds
// 500 lines, so within minutes one recoverable misconfiguration has evicted
// every other line in it — including whatever you opened /log to read. That is
// the opposite of what a log is for.
//
// The rule here: a NEW message is news, the SAME message is not, and both
// recovery and a still-failing outage are news again. Nothing is silently
// dropped — a suppressed run is always accounted for by the line that ends it.

/** Milliseconds between "still failing" reminders while a message repeats. */
const REMIND_EVERY_MS = 15 * 60 * 1000;

export interface RepeatLogDecision {
  /** What to write, or null while the same failure is being suppressed. */
  line: string | null;
  level: "error" | "info";
}

/**
 * Collapses a repeating failure into: the first occurrence, a reminder every
 * 15 minutes with the count so far, and one recovery line naming how long it
 * was down. A changed message always prints — a different failure is a
 * different fact, and hiding it behind "same as before" is how a credentials
 * error masks the network error that replaced it.
 */
export class RepeatLog {
  private last: string | null = null;
  private count = 0;
  private firstAt = 0;
  private lastLoggedAt = 0;

  constructor(private readonly prefix: string) {}

  /** Report a failure. Returns what (if anything) should be written. */
  fail(message: string, now: number): RepeatLogDecision {
    if (message !== this.last) {
      this.last = message;
      this.count = 1;
      this.firstAt = now;
      this.lastLoggedAt = now;
      return { line: `${this.prefix} ${message}`, level: "error" };
    }
    this.count++;
    if (now - this.lastLoggedAt >= REMIND_EVERY_MS) {
      this.lastLoggedAt = now;
      return {
        line: `${this.prefix} still failing after ${this.count} attempts (${minutes(now - this.firstAt)}): ${message}`,
        level: "error",
      };
    }
    return { line: null, level: "error" };
  }

  /** Report a success. Returns a recovery line only if it ends a failing run. */
  ok(now: number): RepeatLogDecision {
    if (this.last === null) return { line: null, level: "info" };
    const line = `${this.prefix} recovered after ${this.count} failed attempts (${minutes(now - this.firstAt)})`;
    this.last = null;
    this.count = 0;
    return { line, level: "info" };
  }
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  return m < 1 ? "under a minute" : `${m} min`;
}
