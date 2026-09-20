// server-clock.ts — the one clock every surface in this app renders from.
//
// This app has ONE clock: the server's. A wall Pi is the reason — an isolated
// production LAN runs no NTP, so a display that has been on the wall for a year
// can be minutes or hours out, and a component reading `Date.now()` reports that
// drift as fact. Three things have to be right for the correction to hold, and
// each of them was wrong in the per-component estimate this replaces.
//
// DELIVERY DELAY. A frame carries the instant the SERVER stamped it. Subtracting
// the browser's clock at the moment it ARRIVES therefore subtracts the delivery
// delay too, so every clock in the building ran exactly one delay behind, for
// ever, by construction. On SSE that is tens of milliseconds and nobody noticed.
// On the polling transport (`?transport=poll`) a frame sits in the server's
// buffer for up to the poll interval first, and the Ultritouch panel measured a
// full two seconds behind. Two answers, depending on what the sample knows:
//
//  - Where there is a request/response pair — the poll transport issues one every
//    couple of seconds and knows when it sent and when it heard back — the round
//    trip is measurable and half of it is added back: the classic
//    `offset = serverSend + rtt/2 - clientReceive`. Its residual error is
//    TWO-signed, at ±rtt/2 on an asymmetric round trip, so these are selected by
//    minimum round trip and never by offset.
//  - Where there is no pairing (a pushed SSE frame, the pco:live keepalive) the
//    delay is unmeasurable but its SIGN is not: it only ever biases the estimate
//    DOWN. So across a window of recent samples the LARGEST offset is the
//    least-delayed and therefore the truest, and that is the one kept — not the
//    newest.
//
// The two live in separate pools for exactly that reason. One filter over both
// picked the most positively biased paired sample and latched it: a single
// stalled poll set the clock two seconds fast and held it there for the whole
// window, which is worse than the newest-sample rule it replaced.
//
// A FRAME IS NOT ALWAYS A READING. The SSE hello burst hands a fresh connection
// every hydrated channel at once, carrying whatever each was last broadcast
// with, and the server neither restamps it nor flags it as a replay. So a clock
// that has never been set will not take a lone unpaired sample, and a clock that
// has will refuse one stamped implausibly far behind its own reading.
//
// HOST CLOCK. Between corrections the displayed time used to advance off
// `Date.now()`, which on the panel this was measured on is seven hours fast and
// gaining about two hours a day. It ticked off that, then snapped back every
// fifteen seconds when a keepalive landed. Here the clock advances off
// `performance.now()` elapsed instead, which no host clock change can move, so a
// host clock that runs fast, runs slow or steps does not move the display at all.
//
// CORRECTIONS. A small correction is eased in rather than applied at once, so
// nothing visibly jumps; a large FORWARD one is applied immediately, because
// easing a genuine clock step at a rate that never reverses would leave the
// display visibly wrong for as long as the error itself. A BACKWARD correction
// is never applied at once and never moves the clock more than a second: the
// displayed time on a stage is allowed to pause and is not allowed to reverse.

import { useEffect, useRef, useState } from "react";

import { logToServer } from "./client-log";

/**
 * How far back samples are kept, in both pools.
 *
 * Two full `pco:live` keepalives (LIVE_KEEPALIVE_MS is 15 s), so a display
 * INSIDE a service window — where `serverNow` moves on every push — always has
 * several unpaired samples to choose between, and a polling client holds fifteen
 * round-trip-measured ones. Outside a service window, or with Planning Center
 * unconfigured, there may be one or none: the filter degrades to the single
 * sample it has, which is why the freshness test below exists rather than
 * relying on there being a better sample beside it.
 *
 * It is also the bound on the other direction: a genuine BACKWARD change to the
 * server's clock lowers every later sample, and the stale maximum from before it
 * cannot outlive the window.
 */
export const SERVER_CLOCK_WINDOW_MS = 30_000;

/**
 * At or above this much disagreement, the correction is applied at once instead
 * of eased in.
 *
 * Equal to SERVER_CLOCK_SLEW_MS on purpose, and that is what picks the number.
 * Easing a difference of `d` over `SERVER_CLOCK_SLEW_MS` runs the displayed
 * clock at a rate of `1 + d/SERVER_CLOCK_SLEW_MS`, so with the two equal the rate
 * stays inside [0, 2]: a correction backwards makes the display pause, never tick
 * backwards, and a correction forwards never runs at more than double speed.
 * Anything past that is not measurement noise — it is a host clock step, a
 * machine resuming from sleep, or the server's own clock being set — and it lands
 * immediately, because a non-reversing ease of an hour would take an hour.
 */
export const SERVER_CLOCK_STEP_MS = 1_000;

/** How long a small correction is eased in over. See SERVER_CLOCK_STEP_MS. */
export const SERVER_CLOCK_SLEW_MS = 1_000;

/**
 * The most the displayed clock may be moved BACKWARD by one correction.
 *
 * SERVER_CLOCK_STEP_MS governs the ease; it says nothing about a step, and a
 * backward step of any size used to land at once. An Ultritouch NOT on
 * `?transport=poll` — which is the default — is served by DashBoard's fallback
 * browser, which holds the event stream and releases a minute of frames in one
 * batch. A frame released 62 s late moved the display back 62 s between two
 * one-second frames: a stage clock that counts up for a minute and then jumps
 * back a minute, which is the failure that matters on a wall.
 *
 * So a backward correction is never stepped. It is eased like any other, and the
 * movement is clamped to this, which equals SERVER_CLOCK_SLEW_MS — so the
 * displayed rate stays at or above 0 and the clock pauses rather than reverses.
 * A genuine backward change to the server's clock is followed at this much per
 * sample: on the polling transport that is 1 s every 2 s, and the clamp says so
 * on `/log` the first time it engages, so a large one is visible rather than
 * silent.
 */
export const SERVER_CLOCK_MAX_BACKWARD_MS = 1_000;

/**
 * How far behind the clock's own reading an unpaired sample may be stamped
 * before it is refused rather than pooled.
 *
 * An unpaired sample carries no measurement of its own delay, so a badly delayed
 * one is indistinguishable from a server clock that moved back — except by size.
 * Five seconds is generous enough for a `pco:live` frame collected inside a poll
 * response (up to one 2 s interval old by design) and for an SSE hiccup, and
 * tight enough to refuse the two readings that are not readings at all: a
 * replayed hello-burst frame minutes old, and a minute's worth of stream
 * released in one batch.
 *
 * Refusal is suspended when it would leave the pool empty. Otherwise a clock
 * that had latched too high would refuse every sample that disagreed with it and
 * never come down — the lock-out a freshness test invites if it has no escape.
 */
export const SERVER_CLOCK_STALE_MS = 5_000;

/**
 * How far apart two unpaired samples must arrive before they can sync a clock
 * that has never been set.
 *
 * The SSE hello burst hands a fresh connection every hydrated channel at once,
 * carrying whatever each was last broadcast with — `pco:live` can be five
 * minutes old outside a service window. Those frames arrive in the same tick, so
 * the rule "two samples, at least a second apart" cannot be satisfied by a burst
 * however many channels it carries, and can be satisfied by the next real frame.
 * One unpaired sample says nothing about its own delay; two, separated in time,
 * bound it.
 *
 * A round-trip-measured sample syncs on its own and immediately: it carries its
 * own delay measurement, so there is nothing to corroborate.
 */
export const SERVER_CLOCK_MIN_SPREAD_MS = 1_000;

/** What the clock reads its two times and writes its log through. Injected so a
 *  test drives the real class with a clock it controls rather than sleeping. */
export interface ServerClockSources {
  /** The host's wall clock. Used ONLY before the first sample lands — once the
   *  clock is synced it is never read again, which is the whole point. */
  wall: () => number;
  /** Monotonic elapsed milliseconds. Must not move when the host clock does. */
  mono: () => number;
  /** One line for an operator, for a correction big enough to be worth reading. */
  log: (message: string) => void;
}

interface Sample {
  /** Where the server's clock sits relative to the monotonic one. */
  offsetMs: number;
  /** The monotonic reading this sample was taken at. */
  atMs: number;
  /** The round trip it was measured over. Paired pool only. */
  rttMs: number;
}

/** What `observe` did with a reading. Returned so a caller — and a test — can
 *  tell each outcome apart. */
export type ServerClockAction =
  | "step"
  | "slew"
  /** Not a number, so not a reading. */
  | "ignored"
  /** Stamped further behind the clock's own reading than a delivery could
   *  plausibly account for — pooling it would drag the clock backwards. */
  | "stale"
  /** Pooled, but the clock has never been set and this is the only unpaired
   *  sample, or the only ones are from a single burst. Nothing to corroborate a
   *  first reading with, so nothing is set. */
  | "waiting";

/**
 * The paired sample with the smallest round trip, newest breaking a tie.
 *
 * NTP's max-delay filter. The smallest round trip is the one whose ±rtt/2
 * asymmetry bound is tightest, and — unlike selecting on the offset — a stalled
 * request is rejected on the measurement that identifies it rather than on the
 * error it produced. With a steady round trip every sample ties and the newest
 * wins, which is what a delay-corrected reading should do.
 */
function bestPaired(pool: readonly Sample[]): number {
  let best = pool[0];
  for (const s of pool) if (s.rttMs <= best.rttMs) best = s;
  return best.offsetMs;
}

/** The largest unpaired offset in the window: delivery delay only ever biases an
 *  unpaired reading DOWN, so the largest is the least delayed. */
function bestUnpaired(pool: readonly Sample[]): number {
  let best = pool[0].offsetMs;
  for (const s of pool) if (s.offsetMs > best) best = s.offsetMs;
  return best;
}

/** Rough duration, signed, for a log line: "7h 2m fast", "2.4s slow". */
function describeOffset(ms: number): string {
  const dir = ms >= 0 ? "fast" : "slow";
  const abs = Math.abs(ms);
  if (abs >= 3_600_000) {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.round((abs % 3_600_000) / 60_000);
    return `${h}h ${m}m ${dir}`;
  }
  if (abs >= 60_000) return `${Math.round(abs / 60_000)}m ${dir}`;
  return `${(abs / 1000).toFixed(1)}s ${dir}`;
}

export class ServerClock {
  /**
   * TWO POOLS, never one.
   *
   * A paired sample's residual error is two-signed at ±rtt/2 on an asymmetric
   * round trip; an unpaired one's is one-signed, downward, by the delivery
   * delay. Selecting the MAXIMUM offset is right for the second and actively
   * wrong for the first — it picks the most positively biased outlier, so one
   * stalled poll set the clock two seconds FAST and the maximum then latched it
   * there for the whole window while twelve healthy polls were ignored. That is
   * worse than trusting the newest sample, which self-corrects on the next one.
   *
   * So: a paired sample is chosen by MINIMUM round trip, which is the standard
   * max-delay filter and rejects the stalled poll on the measurement that
   * actually identifies it rather than on the offset it produced. An unpaired one
   * is chosen by maximum offset, where the one-signed argument holds. Paired wins
   * outright when both pools have something: it is the only reading that knows
   * its own delay.
   */
  private readonly paired: Sample[] = [];
  private readonly unpaired: Sample[] = [];
  /** Where the clock is heading. null until the first usable reading. */
  private targetOffsetMs: number | null = null;
  private slewFromMs = 0;
  private slewStartedAtMs = 0;
  private slewing = false;
  /** True while consecutive corrections are hitting the backward clamp, so the
   *  log line is written once per episode rather than once per sample. */
  private clamping = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly src: ServerClockSources) {}

  /**
   * Be told when the clock STEPS, so a surface can redraw on the frame the
   * correction arrives in rather than waiting out its own tick.
   *
   * Steps only. A slew is under a second and the next tick picks it up; calling
   * back on every eased correction would re-render every subscriber on every
   * pco:live push, at up to 1 Hz through a service, for a change nobody can see.
   * The first reading on a page is a step, which is the one that matters: a
   * calendar on a minute tick would otherwise mark the wrong square for a minute
   * after the frame that said so had already arrived.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announceStep(): void {
    // Copied before iterating: a listener that unsubscribes during the callback
    // is the ordinary React unmount, and mutating the set under its own iterator
    // is how one subscriber costs the next one its call.
    for (const fn of [...this.listeners]) fn();
  }

  /**
   * Take one reading of the server's clock.
   *
   * @param serverMs the instant the SERVER stamped, in epoch milliseconds.
   * @param rttMs the round trip this reading was measured over, where the caller
   *   issued the request itself and knows it. Omit for a pushed frame, which has
   *   no pairing to measure — that reading then goes through the best-of filter
   *   instead, which is the only thing that can recover an unmeasurable delay.
   */
  observe(serverMs: number, rttMs?: number): ServerClockAction {
    if (!Number.isFinite(serverMs)) return "ignored";
    const at = this.src.mono();
    const isPaired = rttMs != null && Number.isFinite(rttMs) && rttMs >= 0;
    this.dropOld(this.paired, at);
    this.dropOld(this.unpaired, at);

    // Refuse an unpaired sample stamped further behind our own reading than a
    // delivery could account for — unless refusing it would leave nothing, in
    // which case it is the only evidence there is and the backward clamp in
    // retarget() is what keeps it from being believed all at once.
    if (!isPaired && this.targetOffsetMs !== null) {
      const reading = at + this.offsetAt(at)!;
      const behind = reading - serverMs;
      const havePooled = this.paired.length > 0 || this.unpaired.length > 0;
      if (behind > SERVER_CLOCK_STALE_MS && havePooled) return "stale";
    }

    if (isPaired) this.paired.push({ offsetMs: serverMs + rttMs / 2 - at, atMs: at, rttMs });
    else this.unpaired.push({ offsetMs: serverMs - at, atMs: at, rttMs: Number.POSITIVE_INFINITY });

    // A clock that has never been set will not take a lone unpaired reading: see
    // SERVER_CLOCK_MIN_SPREAD_MS. Pooled first, so the sample that arrives next
    // is corroborated by this one rather than starting over.
    if (this.targetOffsetMs === null && this.paired.length === 0 && !this.corroborated()) return "waiting";

    const best = this.paired.length > 0 ? bestPaired(this.paired) : bestUnpaired(this.unpaired);
    return this.retarget(best, at);
  }

  /**
   * The current instant on the server's clock, in epoch milliseconds.
   *
   * Falls back to the host's own clock until the first reading lands, which is
   * what every surface rendered before this existed and the only honest answer
   * with nothing to correct against.
   */
  now(): number {
    const at = this.src.mono();
    const offset = this.offsetAt(at);
    // Rounded, because `performance.now()` is fractional and `Date.now()` — what
    // every caller of this used to hold — is not. A fractional epoch reaches
    // `new Date(...)` and string formatting all over the renderer.
    return offset === null ? this.src.wall() : Math.round(at + offset);
  }

  /** False until a reading has landed, i.e. `now()` is still the host's clock. */
  synced(): boolean {
    return this.targetOffsetMs !== null;
  }

  /** Forget everything. For a test, and for nothing else — a page has one clock
   *  for its whole life. */
  reset(): void {
    // Subscribers are deliberately kept: a listener belongs to a mounted
    // component, and forgetting it here would leave that component reading a
    // clock that never tells it anything again.
    this.paired.length = 0;
    this.unpaired.length = 0;
    this.targetOffsetMs = null;
    this.slewing = false;
    this.clamping = false;
    this.slewFromMs = 0;
    this.slewStartedAtMs = 0;
  }

  /** Samples are pushed in monotonic order, so the out-of-window ones are a
   *  prefix. */
  private dropOld(pool: Sample[], at: number): void {
    let drop = 0;
    while (drop < pool.length && pool[drop].atMs < at - SERVER_CLOCK_WINDOW_MS) drop++;
    if (drop > 0) pool.splice(0, drop);
  }

  /** Two unpaired samples far enough apart in arrival to bound each other's
   *  delay. See SERVER_CLOCK_MIN_SPREAD_MS. */
  private corroborated(): boolean {
    if (this.unpaired.length < 2) return false;
    const first = this.unpaired[0].atMs;
    const last = this.unpaired[this.unpaired.length - 1].atMs;
    return last - first >= SERVER_CLOCK_MIN_SPREAD_MS;
  }

  private retarget(target: number, at: number): ServerClockAction {
    const current = this.offsetAt(at);
    if (current === null) {
      // First reading on this page. Nothing to ease from.
      this.targetOffsetMs = target;
      this.slewing = false;
      const hostErrMs = this.src.wall() - (at + target);
      if (Math.abs(hostErrMs) >= SERVER_CLOCK_STEP_MS) {
        this.src.log(`this browser's clock is ${describeOffset(hostErrMs)} — showing server time instead`);
      }
      this.announceStep();
      return "step";
    }
    const diff = target - current;

    // FORWARD. Large enough is a genuine change — a host step, a resume from
    // sleep, the server's clock being set — and lands at once.
    if (diff >= SERVER_CLOCK_STEP_MS) {
      this.targetOffsetMs = target;
      this.slewing = false;
      this.clamping = false;
      this.src.log(`stepped ${describeOffset(diff)} to follow the server`);
      this.announceStep();
      return "step";
    }

    // BACKWARD, at any size, is never stepped and never moves further than
    // SERVER_CLOCK_MAX_BACKWARD_MS at once: the displayed clock pauses instead of
    // ticking backwards. See that constant for the panel this is about.
    let move = diff;
    if (diff < -SERVER_CLOCK_MAX_BACKWARD_MS) {
      move = -SERVER_CLOCK_MAX_BACKWARD_MS;
      if (!this.clamping) {
        this.clamping = true;
        this.src.log(
          `holding the clock back: the server reads ${describeOffset(diff)} of where this display had it, ` +
            `easing rather than jumping`,
        );
      }
    } else if (diff >= 0) {
      this.clamping = false;
    }

    this.slewFromMs = current;
    this.slewStartedAtMs = at;
    this.targetOffsetMs = current + move;
    this.slewing = true;
    return "slew";
  }

  /** The offset in force at monotonic instant `at`, mid-slew included. */
  private offsetAt(at: number): number | null {
    if (this.targetOffsetMs === null) return null;
    if (!this.slewing) return this.targetOffsetMs;
    const k = (at - this.slewStartedAtMs) / SERVER_CLOCK_SLEW_MS;
    if (k >= 1) {
      this.slewing = false;
      return this.targetOffsetMs;
    }
    if (k <= 0) return this.slewFromMs;
    return this.slewFromMs + (this.targetOffsetMs - this.slewFromMs) * k;
  }
}

/**
 * Monotonic milliseconds, or the wall clock where the platform has no
 * `performance` (it is on every browser this runs on and on Node; the guard is
 * for a test harness that stubs `globalThis` down to nothing).
 *
 * Exported because the poll transport measures its round trip with it. Both ends
 * of that measurement and the clock it feeds have to read the SAME source — a
 * round trip measured on the wall clock and applied to a monotonic offset is two
 * different clocks in one subtraction.
 */
export function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** The page's clock. One per document — every surface reads and feeds this one,
 *  so two widgets cannot disagree about what time it is. */
export const serverClock = new ServerClock({
  wall: () => Date.now(),
  mono: monotonicNow,
  log: (message) => logToServer("clock", message),
});

/**
 * Feed one server-stamped timestamp into the page's clock.
 *
 * NEVER the value held at mount. The SSE hello burst that seeds every subscriber
 * is a replayed snapshot — outside a service it can be five minutes old — so a
 * component mounting with one already cached would read the skew from it. The
 * best-of filter would eventually reject a stale sample on its own, but only once
 * a fresher one is in the window beside it; at mount it can be the ONLY sample,
 * and would be adopted as the best of one. Hence the guard, and
 * server-clock-hooks.test.tsx holds it.
 *
 * The mount value is compared by VALUE and stays excluded for the life of the
 * component, not just its first render: React remounts effects under StrictMode,
 * so a "have I run before" flag flips on a pass that has not seen a new frame.
 * Every timestamp this is fed with is minted fresh by the server, so a later
 * frame never repeats the mount value by accident.
 */
export function useServerClockSample(iso: string | null | undefined): void {
  const atMount = useRef(iso);
  useEffect(() => {
    if (!iso || iso === atMount.current) return;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) serverClock.observe(ms);
  }, [iso]);
}

/**
 * The current instant on the server's clock, advancing every `intervalMs`.
 *
 * @param intervalMs how often the returned value moves. Pick the coarsest
 *   cadence the caller can live with: it is a re-render each time.
 * @param enabled false where the caller was handed a clock already and only calls
 *   this because a hook cannot be conditional. Off, it does not tick.
 */
export function useServerNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    if (!enabled) return;
    // Cleanup is load-bearing: the operator app is a persistent shell, so an
    // interval that outlives its component runs for the whole service.
    const id = setInterval(() => setNow(serverClock.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  // And redraw on a correction rather than at the next tick. A calendar ticks
  // once a MINUTE, so without this a display whose clock is days out marks the
  // wrong square for a minute after the frame that said so has arrived.
  useEffect(() => {
    if (!enabled) return;
    return serverClock.subscribe(() => setNow(serverClock.now()));
  }, [enabled]);
  return now;
}

/**
 * Feed the page's clock from a server-stamped timestamp the caller already holds,
 * and read the corrected instant back out. The shape every surface that renders
 * against `pcoLive.serverNow` wants.
 */
export function useServerClock(sample: string | null | undefined, intervalMs = 1000): number {
  useServerClockSample(sample);
  return useServerNow(intervalMs);
}
