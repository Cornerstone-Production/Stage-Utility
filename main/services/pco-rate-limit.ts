// pco-rate-limit.ts — what Planning Center says about our quota, on every response.
//
// PCO puts three headers on EVERY response, success or failure:
//
//   X-PCO-API-Request-Rate-Limit    requests allowed in the window
//   X-PCO-API-Request-Rate-Period   the window, in seconds
//   X-PCO-API-Request-Rate-Count    requests used in the window so far
//
// The client read none of them. It reacted only to a 429 that had already
// happened, honouring Retry-After — which is a fine last resort and a poor first
// one: by then a display has already missed a countdown tick.
//
// They cannot be replaced by a constant. PCO's documentation says applications
// "should never hard-code rate limit values" because the limit is dynamic and
// per-endpoint, and PCO staff say on the record to rely on these headers; one
// reported endpoint answered with a limit of 10 where the documented default is
// 100. Anything in this repository reasoning in prose about "well under 100 per
// 20s" is reasoning about a number PCO does not promise.
//
// NOT ETag / If-Modified-Since. A 304 counts against the same quota, so a
// conditional request spends the scarce thing (a request) to save the plentiful
// one (bytes). That decision is deliberate and stays.

/** One observation of the three headers. */
export interface RateObservation {
  /** Requests allowed in the window PCO is reporting. */
  limit: number;
  /** Length of that window, in seconds. */
  periodSec: number;
  /** Requests used in it so far. */
  count: number;
  /** When this was observed (ms epoch). */
  at: number;
}

/** What an operator or a caller needs to know right now. */
export interface RateStatus extends RateObservation {
  /** count / limit, 0–1. */
  used: number;
  /** Requests left in the window. Never below 0 — PCO can report count > limit. */
  remaining: number;
  /** True while the app is deliberately holding back. */
  tight: boolean;
}

/** Header names, exactly as PCO spells them. Matched case-insensitively by
 *  `Headers.get`, but written here the way they appear on the wire. */
export const RATE_LIMIT_HEADER = "X-PCO-API-Request-Rate-Limit";
export const RATE_PERIOD_HEADER = "X-PCO-API-Request-Rate-Period";
export const RATE_COUNT_HEADER = "X-PCO-API-Request-Rate-Count";

/** A header as a non-negative finite number, or null. */
function num(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The three headers off one response, or null when they are not all usable.
 *
 * All three or nothing. A limit with no count says nothing about headroom, and a
 * count with a limit of zero is a division by zero dressed as data — reading a
 * partial set would put the app into a permanent hold on a malformed response.
 *
 * @param headers any Headers-like lookup; `Response.headers` in practice.
 */
export function readRateHeaders(
  headers: { get(name: string): string | null },
  at: number,
): RateObservation | null {
  const limit = num(headers.get(RATE_LIMIT_HEADER));
  const count = num(headers.get(RATE_COUNT_HEADER));
  if (limit === null || count === null || limit <= 0) return null;
  // The period is the only one with a sane default: it is used for staleness, not
  // for the headroom fraction, so a missing one costs precision rather than
  // correctness.
  const periodSec = num(headers.get(RATE_PERIOD_HEADER)) ?? 0;
  return { limit, periodSec, count, at };
}

/**
 * The latest observed headroom, with hysteresis on "are we holding back".
 *
 * Deliberately a plain object with no timers and no I/O: the transport calls
 * `observe()` on every response and asks `tight` before it grants a slot, and
 * everything about when to log and when to slow down is decided from the numbers
 * PCO last sent.
 *
 * `observe` returns a TRANSITION rather than logging itself, so the one line per
 * episode is written by the caller that knows the log tag — and so this file can
 * be driven in a test without capturing console output.
 */
export class PcoRateLimit {
  private last: RateObservation | null = null;
  private holding = false;

  /**
   * How long an observation is believed, in ms. Past this the app stops holding
   * back on it: the window it described has moved on, and throttling for an
   * episode that ended is worse than not throttling at all.
   */
  constructor(
    private readonly stalePeriods: number,
    private readonly defaultPeriodSec: number,
    private readonly tightAt: number,
    private readonly clearAt: number,
  ) {}

  /** Is `obs` still describing a window we are plausibly inside? */
  private fresh(obs: RateObservation, now: number): boolean {
    const periodSec = obs.periodSec > 0 ? obs.periodSec : this.defaultPeriodSec;
    return now - obs.at <= periodSec * this.stalePeriods * 1000;
  }

  /**
   * Record one response's headers.
   *
   * @returns "tight" or "clear" on the response that crossed a threshold, else
   *   null. Exactly one transition per episode, which is what lets the caller log
   *   once rather than once per request.
   */
  observe(obs: RateObservation | null, now: number): "tight" | "clear" | null {
    if (!obs) return null;
    // A gap longer than the staleness horizon ends the episode, silently. Without
    // this, an app that went tight, sat idle overnight and came back tight would
    // still be "holding" from yesterday, so the new episode would produce no
    // transition and no line — an operator would see the app throttling itself
    // with nothing in the log saying when it started.
    if (this.last && !this.fresh(this.last, now)) this.holding = false;
    this.last = obs;
    const used = obs.count / obs.limit;
    // Two thresholds with a gap between them. One line would flap on every
    // request that straddles it, and each flap is a log line and a cadence change.
    if (!this.holding && used >= this.tightAt) {
      this.holding = true;
      return "tight";
    }
    if (this.holding && used < this.clearAt) {
      this.holding = false;
      return "clear";
    }
    return null;
  }

  /**
   * Should the app hold back right now?
   *
   * False when the last observation has aged out, so an episode that ended does
   * not throttle the app indefinitely. The flag itself is left set: the next
   * observation decides, and clearing it here would emit a "recovered" line for
   * a recovery nobody observed.
   */
  tight(now: number): boolean {
    return this.holding && this.last !== null && this.fresh(this.last, now);
  }

  /** The current picture, or null when PCO has not been heard from. */
  status(now: number): RateStatus | null {
    const obs = this.last;
    if (!obs) return null;
    return {
      ...obs,
      used: obs.count / obs.limit,
      remaining: Math.max(0, obs.limit - obs.count),
      tight: this.tight(now),
    };
  }

  /** Forget everything. For tests and for a credential change — the old app's
   *  quota says nothing about the new one's. */
  reset(): void {
    this.last = null;
    this.holding = false;
  }
}

/** One line an operator can read, from a status. Shared by the log line and the
 *  /log health strip so the two cannot describe the same state differently. */
export function describeRate(s: RateStatus): string {
  const window = s.periodSec > 0 ? `${s.periodSec}s` : "window";
  return `${s.count}/${s.limit} requests used in PCO's ${window}`;
}
