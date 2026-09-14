// ticker.ts — one self-rescheduling timer, with one rule.
//
// THE RULE: after every tick, armed again unless stopped.
//
// It exists because the alternative was written three times in one file and got
// it wrong on the second. A hand-rolled `setTimeout` poller looks like this:
//
//     private async read(): Promise<void> {
//       if (!this.running || this.inFlight || this.testing) return;   // <- here
//       try { ...the work... }
//       finally { this.rearm(); }                                     // <- only re-arm
//     }
//
// Every one of those guard clauses reads as "there is nothing to do this tick".
// Three of them mean exactly that. One — `!this.running` — means "stop". They are
// spelled identically, they sit above the `try`, and so the three that meant
// "defer" silently meant "cancel": the one-shot timer was never re-armed and the
// reading was dead until the next save or restart. In production that was
// SenSource's SafeSpace occupancy, killed for good by pressing Test connection.
//
// So the tick body does not get to touch the timer. It returns a VALUE saying
// what it did; the ticker arms the next one either way. "Skip this tick" is then
// a deferral BY CONSTRUCTION, and there is no way left to spell a cancellation
// from inside the body at all.
//
// Two things a tick body legitimately must not re-arm after, and neither is the
// body's call:
//
//   - the owner stopped. `wanted()` is asked before every arm, including the
//     re-arm, so stopping is a property of the owner and not of a return value.
//   - the configuration was replaced mid-tick. `generation()` is read before the
//     tick and again after: if it moved, whoever moved it owns the timer now and
//     re-arming here would replace the fresh timer with one scoped to a
//     configuration nobody is running.
//
// A throw from the body re-arms and then propagates, which is what the
// try/finally it replaces did. `run()` is normally called as `void ticker.run()`
// off a timer with no caller to hand a rejection to, so the rejection reaches
// server.ts's unhandledRejection handler and is written to /log — a visible,
// once-per-occurrence trace, with the reading still running.

/** The outcome alphabet most tick bodies want: it did the work, or it could not
 *  this time. `Ticker` does not care which — both re-arm — but the delay may. */
export type TickOutcome = "done" | "skip";

export interface TickerOptions<Outcome> {
  /**
   * One tick. Returns what it did; MUST NOT arm, cancel or otherwise touch the
   * timer — that is the whole point (see the file header). May throw; the next
   * tick is armed first, then the rejection propagates.
   */
  tick: () => Promise<Outcome>;
  /**
   * How long until the next tick, given what this one did. `null` means the tick
   * threw, so a caller that varies the delay by outcome has to say what an
   * unknown outcome waits — usually the ordinary cadence.
   */
  nextDelayMs: (outcome: Outcome | null) => number;
  /**
   * Is there anything for this ticker to do at all? Asked before EVERY arm,
   * including the re-arm after a tick, so "the owner has stopped" and "this
   * sub-feature is switched off" are properties of the owner rather than
   * something a tick body has to remember to express.
   */
  wanted: () => boolean;
  /**
   * Which configuration this ticker is serving. Read before the tick and again
   * after: a tick whose generation moved while it ran does not re-arm, because
   * the reconfigure that moved it has already armed a timer of its own.
   *
   * Omit it for a ticker with no such notion; then no tick is ever superseded.
   */
  generation?: () => number;
}

export class Ticker<Outcome = TickOutcome> {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: TickerOptions<Outcome>) {}

  /** Is a tick pending? Not "is a tick running" — see `run`. */
  get armed(): boolean {
    return this.timer !== null;
  }

  /**
   * Queue the next tick, replacing any tick already queued.
   *
   * Refuses while `wanted()` is false, and deliberately WITHOUT cancelling what
   * is already armed: an owner that wants the timer gone calls `cancel()`, which
   * says so. (This is the order the hand-rolled schedulers had, kept so a
   * mid-flight configuration change cannot silently disarm a running poller.)
   */
  arm(delayMs: number): void {
    if (!this.opts.wanted()) return;
    this.cancel();
    this.timer = setTimeout(() => void this.run(), delayMs);
  }

  /** Drop the pending tick. A tick already RUNNING still re-arms unless
   *  `wanted()` has gone false by the time it finishes — which is why an owner
   *  clears its running flag before calling this, not after. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one tick now and arm the next.
   *
   * Also how a poller takes its FIRST tick — there is no separate "start", so
   * the first tick and every later one go through the same re-arm.
   */
  async run(): Promise<void> {
    // This tick IS the pending one, whether it came from the timer or from a
    // direct call. Clearing it here keeps `armed` honest for the whole tick and
    // stops cancel() from clearing a handle that has already fired.
    this.cancel();
    const generation = this.opts.generation?.() ?? 0;
    let outcome: Outcome | null = null;
    try {
      outcome = await this.opts.tick();
    } finally {
      // THE RULE, in the one place it is written. Not in the body, not per
      // return path, and not duplicated per caller.
      if ((this.opts.generation?.() ?? 0) === generation) {
        this.arm(this.opts.nextDelayMs(outcome));
      }
    }
  }
}
