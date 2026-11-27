// meter-tween.ts — Q-SYS meters ease between samples instead of jumping.
//
// A meter push arrives at the panel's meter rate (10 or 20 a second, set in
// Settings, and never told to the page). Each sample starts a tween from where
// the bar is drawn now to the new level, lasting one sample interval, so the bar
// arrives as the next sample does. The interval is measured from the spacing of
// the samples themselves.
//
// Drawn on requestAnimationFrame, and only while something is still moving and
// the page is visible. A hidden page draws nothing, and a meter whose last
// sample is stale (the page was hidden, or the stream paused) jumps to its next
// sample rather than sweeping up from a height that stopped meaning anything.
//
// Bars are written straight to their elements through `MeterSink`, never
// through React state: twenty strips at twenty samples a second would otherwise
// re-render the panel four hundred times a second. The sink sets a transform
// (compositor-only, no layout) and the colour only when its band changes, so a
// frame on a Pi costs no layout or repaint of the panel.
//
// A loop, not a CSS transition on the bar: the tween lasts one MEASURED sample
// interval, which the page is never told, and a stale meter jumps instead of
// sweeping. A fixed transition would trail a 10 Hz meter by a sample or cut a
// 20 Hz one short, and would sweep up from a height left over from before a
// hide. The browser already pauses this loop on a hidden page (rAF), as it would
// a transition.

import { prefersReducedMotion } from "../../lib/reduced-motion";

/**
 * The curve of `--motion-ease` in styles.css, cubic-bezier(0.2, 0.6, 0.2, 1):
 * arrives and settles. Both y control points are within 0..1, so it never
 * overshoots its target.
 */
const EASE = { x1: 0.2, y1: 0.6, x2: 0.2, y2: 1 } as const;

function bezierAt(a: number, b: number, t: number): number {
  // One axis of a cubic bezier from (0,0) to (1,1) with control values a and b.
  const u = 1 - t;
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
}

/** y on the ease curve at x (0..1), by bisection: monotonic, and exact enough to draw. */
export function meterEase(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bezierAt(EASE.x1, EASE.x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return bezierAt(EASE.y1, EASE.y2, (lo + hi) / 2);
}

/**
 * Where a meter is drawn `elapsedMs` into a tween from `from` to `to` that lasts
 * `intervalMs`: eased within the interval, exactly `to` from its end on, and
 * never outside the two.
 */
export function tweenMeter(from: number, to: number, elapsedMs: number, intervalMs: number): number {
  if (!(intervalMs > 0) || elapsedMs >= intervalMs) return to;
  if (!(elapsedMs > 0)) return from;
  const v = from + (to - from) * meterEase(elapsedMs / intervalMs);
  return from < to ? Math.min(to, Math.max(from, v)) : Math.max(to, Math.min(from, v));
}

/** Sample spacing this far apart or more is a pause, not a rate: the next sample jumps. */
export const METER_STALE_MS = 600;
/** A measured interval is held to this range, so one early or late push cannot make a tween absurd. */
const MIN_INTERVAL_MS = 25;
const MAX_INTERVAL_MS = 250;

/** Where a meter's level (0..1) is drawn. */
export interface MeterSink {
  draw: (level: number) => void;
}

interface Track {
  from: number;
  to: number;
  current: number;
  start: number;
  interval: number;
  /** When the last sample arrived; null when the next one must jump. */
  last: number | null;
  sinks: Set<MeterSink>;
}

export interface AnimatorEnv {
  now: () => number;
  requestFrame: (cb: (t: number) => void) => number;
  cancelFrame: (id: number) => void;
  hidden: () => boolean;
  reducedMotion: () => boolean;
}

const browserEnv: AnimatorEnv = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  reducedMotion: prefersReducedMotion,
};

/** Every meter of one panel, and the one animation frame loop that draws them. */
export class MeterAnimator {
  private readonly tracks = new Map<string, Track>();
  private frame: number | null = null;

  constructor(private readonly env: AnimatorEnv = browserEnv) {}

  /** Draw meter `key` into `sink` from now on. Returns the function that stops it. */
  add(key: string, sink: MeterSink): () => void {
    const track = this.track(key);
    track.sinks.add(sink);
    sink.draw(track.current);
    return () => {
      track.sinks.delete(sink);
      if (track.sinks.size === 0 && this.tracks.get(key) === track) this.tracks.delete(key);
    };
  }

  /** A new level for meter `key`. `jump` draws it at once, as a hydration does. */
  sample(key: string, level: number, jump = false): void {
    const track = this.track(key);
    const now = this.env.now();
    const gap = track.last === null ? null : now - track.last;
    // A sample taken while hidden is no basis for a tween after waking.
    const hidden = this.env.hidden();
    track.last = hidden ? null : now;
    if (jump || gap === null || gap >= METER_STALE_MS || hidden || this.env.reducedMotion()) {
      track.from = track.to = track.current = level;
      track.start = now;
      track.interval = 0;
      this.draw(track);
      return;
    }
    track.from = track.current;
    track.to = level;
    track.start = now;
    track.interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, gap));
    this.ensureFrame();
  }

  /** The page was hidden: stop drawing, and make every meter's next sample jump. */
  pause(): void {
    if (this.frame !== null) this.env.cancelFrame(this.frame);
    this.frame = null;
    for (const t of this.tracks.values()) {
      t.last = null;
      t.from = t.current = t.to;
    }
  }

  /** Stop the loop and forget every meter. */
  dispose(): void {
    this.pause();
    this.tracks.clear();
  }

  /** Whether a frame is scheduled; for tests. */
  get running(): boolean {
    return this.frame !== null;
  }

  private track(key: string): Track {
    let t = this.tracks.get(key);
    if (!t) {
      t = { from: 0, to: 0, current: 0, start: 0, interval: 0, last: null, sinks: new Set() };
      this.tracks.set(key, t);
    }
    return t;
  }

  private draw(t: Track): void {
    for (const s of t.sinks) s.draw(t.current);
  }

  private ensureFrame(): void {
    if (this.frame !== null) return;
    this.frame = this.env.requestFrame(() => this.tick());
  }

  private tick(): void {
    this.frame = null;
    if (this.env.hidden()) return;
    const now = this.env.now();
    let moving = false;
    for (const t of this.tracks.values()) {
      if (t.current === t.to) continue;
      t.current = tweenMeter(t.from, t.to, now - t.start, t.interval);
      this.draw(t);
      if (t.current !== t.to) moving = true;
    }
    if (moving) this.ensureFrame();
  }
}
