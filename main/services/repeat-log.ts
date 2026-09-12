// repeat-log.ts — say it once per OUTAGE, not once per poll and not once per flap.
//
// A poller that fails keeps failing: PCO credentials go stale and every tick
// writes the same line, 900 an hour at the live cadence. The log buffer holds
// 10,000 lines, so within hours one recoverable misconfiguration has evicted
// every other line in it — including whatever you opened /log to read. That is
// the opposite of what a log is for.
//
// The rule here: a NEW failure is news, the SAME failure is not, a long outage
// reminds you it is still going, and a recovery is news once. Nothing is silently
// dropped — a suppressed run is always accounted for by the line that ends it.
//
// ── Why a "first failure, then quiet" flag is not enough ───────────────────
//
// That is what this file used to be, and it is what sensource-service.ts's
// per-transition flags were, and the measured result in production was 3,527
// warning and error lines from SenSource alone in five days — 2,837 of them in
// one day — against under 200 for everything else combined.
//
// The reason is that a transition guard assumes an outage is a solid block. A
// flaky upstream does not fail that way: it fails, succeeds, fails, succeeds.
// Every success clears the flag, so every failure is a fresh "first failure" and
// the guard writes a line on each one. The flag was doing exactly what it was
// written to do and the log was still unreadable.
//
// So a run does not END on the first success. It ends on a success that has HELD
// for `settleMs` — which is what makes an alternating 401/200 one outage with one
// line rather than one per poll. `settleMs` has to be longer than the caller's
// poll, or every success outlasts it and the rule is the transition flag again;
// a caller whose interval the operator sets says so with `settleAfter`.
//
// The reminder floor is the second half: even if something else resets the state,
// an endpoint cannot speak more than once per `remindMs` per failure kind.
//
// KINDS stay distinguishable. A 401 storm and a 503 storm are different problems
// and must not collapse into one another, so the first of each kind inside a run
// is news. Bounded per kind by the same reminder floor, so two kinds alternating
// cannot spam either — and past MAX_KINDS_PER_RUN they share one bucket, so an
// upstream varying its message text cannot mint an unlimited supply of "new"
// kinds and talk once per report through the floor.

/** Milliseconds between "still failing" reminders while a run continues. */
const REMIND_EVERY_MS = 15 * 60 * 1000;
/**
 * How long a success must hold before a run is declared over.
 *
 * Two minutes is several polls at every FIXED cadence in this app (REAPER and
 * ProPresenter seconds, the PCO live tick 1s), so a genuine recovery is announced
 * within a couple of minutes while an upstream flapping every other poll stays
 * one outage.
 *
 * It is a DEFAULT and not a law, because a caller whose cadence the operator sets
 * can poll slower than this — see `settleAfter`.
 */
export const DEFAULT_SETTLE_MS = 2 * 60 * 1000;
/**
 * Distinct failure kinds remembered inside one run.
 *
 * A kind is usually a status or a class name, so the real number is one or two.
 * The cap exists because RepeatLog's kind is the message text, which an upstream
 * can vary without limit — an unbounded map inside a run that never ends is a
 * slow leak.
 */
const MAX_KINDS_PER_RUN = 8;

/** What to do about one report. */
export interface OutageDecision {
  /** Write a line, or stay quiet. */
  log: boolean;
  /** Tail to append — the attempt count and duration on a reminder or a
   *  recovery, and an empty string on the first failure of a run. */
  note: string;
}

const QUIET: OutageDecision = { log: false, note: "" };

interface Run {
  /** Failures since the run opened, across every kind. */
  count: number;
  /** When the run opened. */
  firstAt: number;
  /** The most recent failure, whatever kind. A run ends only once a success has
   *  held for `settleMs` past this. */
  lastFailAt: number;
  /** Per failure kind, when it was last written. Never larger than
   *  MAX_KINDS_PER_RUN — everything past that shares `overflowAt`. */
  spokenAt: Map<string, number>;
  /**
   * When the OVERFLOW bucket last spoke, once the run has seen more kinds than
   * it will remember. Undefined until then.
   *
   * The cap used to EVICT the oldest kind, which is the wrong trade. An upstream
   * whose message carries a timestamp or a request id rotates through kinds
   * without limit; every eviction makes an already-seen kind new again, and "one
   * line per kind per 15 minutes" degrades to one line per report — the flood the
   * cap was sitting right next to. Folding the overflow into one shared bucket
   * bounds the map AND keeps the floor. This repo has already been bitten by the
   * varying-body shape once, in this integration.
   */
  overflowAt?: number;
}

/**
 * One run per key, with flap tolerance and a reminder floor.
 *
 * Keys are the caller's: SenSource uses one per failing endpoint so a dead
 * `/space` listing and a dead `/data/traffic` are separate facts, which is the
 * whole reason this is keyed rather than a flag per call site.
 *
 * Pure and clock-injected: no timers, no console, `now` passed in. The caller
 * writes the line, because the caller owns the wording an operator reads.
 */
export class OutageLog {
  private readonly runs = new Map<string, Run>();

  constructor(
    private settleMs: number = DEFAULT_SETTLE_MS,
    private readonly remindMs: number = REMIND_EVERY_MS,
  ) {}

  /**
   * Replace the settle window.
   *
   * For a caller whose cadence the OPERATOR sets. A settle window shorter than
   * one poll ends the run on every single success, which is the
   * once-per-transition rule this class exists to replace — so an absolute
   * default is only safe while the caller polls faster than it. SenSource's
   * interval has no ceiling (the field allows an hour, and its help text invites
   * raising it to cut API calls), so at 300s a fixed two minutes puts the 2,837
   * lines straight back.
   */
  settleAfter(ms: number): void {
    this.settleMs = ms;
  }

  /**
   * Report a failure of `key`, of kind `kind`.
   *
   * @returns whether to write a line, and the tail to append if it is a reminder.
   */
  fail(key: string, kind: string, now: number): OutageDecision {
    const run = this.runs.get(key);
    if (!run) {
      this.runs.set(key, {
        count: 1,
        firstAt: now,
        lastFailAt: now,
        spokenAt: new Map([[kind, now]]),
      });
      return { log: true, note: "" };
    }

    run.count++;
    run.lastFailAt = now;

    // Past the cap, an unremembered kind is timed against the shared overflow
    // bucket rather than being admitted — see Run.overflowAt.
    const overflow = !run.spokenAt.has(kind) && run.spokenAt.size >= MAX_KINDS_PER_RUN;
    const spoken = overflow ? run.overflowAt : run.spokenAt.get(kind);
    // A kind not yet heard in this run is a different problem, and hiding it
    // behind "same as before" is how a credentials error masks the network error
    // that replaced it.
    if (spoken === undefined) {
      remember(run, kind, overflow, now);
      return { log: true, note: "" };
    }
    if (now - spoken >= this.remindMs) {
      remember(run, kind, overflow, now);
      return {
        log: true,
        note: ` — still failing after ${plural(run.count, "attempt")} (${minutes(now - run.firstAt)})`,
      };
    }
    return QUIET;
  }

  /**
   * Report a success of `key`.
   *
   * @returns a recovery decision only once the run has genuinely settled. A
   *   success arriving inside `settleMs` of the last failure is a gap in a
   *   flapping outage, not the end of one, and saying "recovered" there is what
   *   turned one bad afternoon into 2,837 log lines.
   */
  ok(key: string, now: number): OutageDecision {
    const run = this.runs.get(key);
    if (!run) return QUIET;
    if (now - run.lastFailAt < this.settleMs) return QUIET;
    this.runs.delete(key);
    return {
      log: true,
      note: ` after ${plural(run.count, "failed attempt")} (${minutes(now - run.firstAt)})`,
    };
  }

  /** Is `key` inside a failing run right now? For a caller that wants to report
   *  degraded state somewhere other than the log. */
  failing(key: string): boolean {
    return this.runs.has(key);
  }

  /** Drop every run. For a reconfigure: nothing learned about the old
   *  credentials or the old scope is true of the new ones, and carrying a run
   *  across would suppress the first line of the next outage. */
  forget(): void {
    this.runs.clear();
  }
}

/** Note that `kind` has just been written, against its own slot or against the
 *  shared overflow bucket once the run is full. */
function remember(run: Run, kind: string, overflow: boolean, now: number): void {
  if (overflow) run.overflowAt = now;
  else run.spokenAt.set(kind, now);
}

export interface RepeatLogDecision {
  /** What to write, or null while the same failure is being suppressed. */
  line: string | null;
  level: "error" | "info";
}

/**
 * One subject's outage, as a ready-made line.
 *
 * A thin wrapper over a single-key OutageLog rather than a second copy of the
 * rules — "log once per outage" existing in two implementations is precisely how
 * this repository's patterns drift. The message text IS the kind here, so a
 * different message is news, which is the behaviour its callers were written
 * against.
 */
export class RepeatLog {
  private readonly outage: OutageLog;

  constructor(
    private readonly prefix: string,
    settleMs?: number,
    remindMs?: number,
  ) {
    this.outage = new OutageLog(settleMs, remindMs);
  }

  /** Report a failure. Returns what (if anything) should be written. */
  fail(message: string, now: number): RepeatLogDecision {
    const d = this.outage.fail("", message, now);
    return { line: d.log ? `${this.prefix} ${message}${d.note}` : null, level: "error" };
  }

  /** Report a success. Returns a recovery line only if it ends a settled run. */
  ok(now: number): RepeatLogDecision {
    const d = this.outage.ok("", now);
    return { line: d.log ? `${this.prefix} recovered${d.note}` : null, level: "info" };
  }
}

/** `1 attempt` / `2 attempts`. A recovery after a single failure read
 *  "recovered after 1 failed attempts", which is the sort of thing an operator
 *  reads as a bug in the thing that wrote it. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60000);
  return m < 1 ? "under a minute" : `${m} min`;
}
