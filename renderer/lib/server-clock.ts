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
//    `offset = serverSend + rtt/2 - clientReceive`.
//  - Where there is no pairing (a pushed SSE frame, the pco:live keepalive) the
//    delay is unmeasurable but its SIGN is not: it only ever biases the estimate
//    DOWN. So across a window of recent samples the LARGEST offset is the
//    least-delayed and therefore the truest, and that is the one kept — not the
//    newest.
//
// HOST CLOCK. Between corrections the displayed time used to advance off
// `Date.now()`, which on the panel this was measured on is seven hours fast and
// gaining about two hours a day. It ticked off that, then snapped back every
// fifteen seconds when a keepalive landed. Here the clock advances off
// `performance.now()` elapsed instead, which no host clock change can move, so a
// host clock that runs fast, runs slow or steps does not move the display at all.
//
// CORRECTIONS. A small correction is eased in rather than applied at once, so
// nothing visibly jumps; a large one is applied immediately, because easing a
// genuine clock step at a rate that never reverses would leave the display
// visibly wrong for as long as the error itself.

import { useEffect, useRef, useState } from "react";

import { logToServer } from "./client-log";

/**
 * How far back samples are kept for the best-of filter.
 *
 * Two full `pco:live` keepalives (LIVE_KEEPALIVE_MS is 15 s), so even the
 * quietest channel — a display sitting outside a service window, where the only
 * thing moving `serverNow` is the keepalive — always has more than one sample to
 * choose between. On the polling transport it holds fifteen round-trip-corrected
 * ones. It is also the bound on the other direction: a genuine BACKWARD change
 * to the server's clock lowers every later sample, and the stale maximum from
 * before it cannot outlive the window.
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
  /** `serverMs (+ rtt/2) - mono` — where the server's clock sits relative to the
   *  monotonic one. Biased LOW by any delivery delay not accounted for. */
  offsetMs: number;
  /** The monotonic reading this sample was taken at. */
  atMs: number;
}

/** What `observe` did with a reading. Returned so a caller — and a test — can
 *  tell a step from a slew from a reading that was not usable at all. */
export type ServerClockAction = "step" | "slew" | "ignored";

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
  private readonly samples: Sample[] = [];
  /** Where the clock is heading. null until the first usable reading. */
  private targetOffsetMs: number | null = null;
  private slewFromMs = 0;
  private slewStartedAtMs = 0;
  private slewing = false;

  constructor(private readonly src: ServerClockSources) {}

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
    const half = rttMs != null && Number.isFinite(rttMs) && rttMs >= 0 ? rttMs / 2 : 0;
    this.samples.push({ offsetMs: serverMs + half - at, atMs: at });
    this.dropStale(at);
    let best = this.samples[0].offsetMs;
    for (const s of this.samples) if (s.offsetMs > best) best = s.offsetMs;
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
    this.samples.length = 0;
    this.targetOffsetMs = null;
    this.slewing = false;
    this.slewFromMs = 0;
    this.slewStartedAtMs = 0;
  }

  /** Samples are pushed in monotonic order, so the stale ones are a prefix. The
   *  reading just pushed is `at` old, so this can never empty the array. */
  private dropStale(at: number): void {
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].atMs < at - SERVER_CLOCK_WINDOW_MS) drop++;
    if (drop > 0) this.samples.splice(0, drop);
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
      return "step";
    }
    const diff = target - current;
    if (Math.abs(diff) >= SERVER_CLOCK_STEP_MS) {
      this.targetOffsetMs = target;
      this.slewing = false;
      this.src.log(`stepped ${describeOffset(diff)} to follow the server`);
      return "step";
    }
    this.slewFromMs = current;
    this.slewStartedAtMs = at;
    this.targetOffsetMs = target;
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

/** Monotonic milliseconds, or the wall clock where the platform has no
 *  `performance` (it is on every browser this runs on and on Node; the guard is
 *  for a test harness that stubs `globalThis` down to nothing). */
function monotonicNow(): number {
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
 * server-clock.test.ts holds it.
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
