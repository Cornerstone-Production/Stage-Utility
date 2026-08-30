// readout-meter.tsx — the app's hairline progress rule: when it may glide to a
// new value, when it must snap to it, and the one element that draws it.
//
// The rule is fed by a countdown that ticks once a second, so the bar it drew
// stepped once a second too: a visible jump on a wall display, which is what the
// operator reported. The fix is a CSS transition on the fill's width timed to
// the tick — the browser interpolates between the two values it is given, at no
// render cost at all. Explicitly NOT requestAnimationFrame: sixty React renders
// a second per widget, for a two-pixel hairline, on hardware that is often a Pi.
//
// A transition is only honest while the value is ADVANCING NORMALLY. The three
// cases in `meterSmooth` are the ones where a one-second glide would draw
// something that never happened.
//
// ONE IMPLEMENTATION, because there are two rules and they are the same rule:
// the readout composition's `meter` (ProVideoPlayer "now") and the per-row rule
// in the ProVideoPlayer layer list. Both read `computePvpProgress`, both tick at
// 1 Hz, and both stepped. Fixing one and leaving the other is the mistake this
// repo makes most often, so the second one imports this instead of copying it.
//
// jsdom can observe neither a transition nor a rendered width, so what a test
// can reach here is the DECISION and the duration written for it — see
// readout-meter.test.tsx.

import { useState, type CSSProperties } from "react";

/**
 * How long the fill takes to reach the value it has just been given.
 *
 * The tick it is interpolating: both surfaces that draw a readout advance `now`
 * on a 1000 ms interval (layout-renderer.tsx and home-route.tsx), so the fill
 * arrives at each value exactly as the next one lands. A shorter duration puts
 * the stepping back with a pause on the end of it; a longer one leaves the bar
 * permanently behind the number written beside it.
 */
export const METER_TICK_MS = 1000;

/**
 * A forward jump bigger than this is not a tick, so it is not glided.
 *
 * The rule cannot know how long the clip is, so it cannot know what one second
 * SHOULD look like. What it can say is that a fifth of the whole bar in one tick
 * is a scrub, a seek, or a display that has been asleep — the cases where a
 * one-second glide draws a passage of time that did not happen.
 *
 * The trade is deliberate: a clip shorter than five seconds advances more than
 * this per tick and therefore steps. A five-second clip crosses the whole widget
 * while you look at it, and stepping is the honest way to draw that.
 */
export const METER_SNAP_JUMP_PCT = 20;

/**
 * Backwards by less than this is a re-anchor correcting drift, not a rewind.
 *
 * A twentieth of a percent is under a pixel on any bar an operator would place,
 * and two orders of magnitude below the smallest real rewind — a loop or a cue
 * change resets the fraction to near zero from wherever it had got to. Without
 * it, the server re-anchoring a hair behind where the client had interpolated to
 * counts as a discontinuity, and a smooth bar stalls for a whole second to
 * correct something a fraction of a pixel wide.
 */
export const METER_DRIFT_PCT = 0.05;

/**
 * A fraction as a percentage of the track: clamped to 0..100, and NEVER NaN.
 *
 * The clamp is here rather than at each call site because it now has to hold for
 * the component to be safe at all. `MeterFill` compares the incoming value with
 * the last one to decide whether to interpolate, and `NaN !== NaN`, so a NaN
 * fraction made that comparison true on every pass and the render-phase update
 * re-fired for ever — React gives up with "Too many re-renders" and takes the
 * whole widget tree down with it. The version this replaced merely wrote
 * `width: NaN%`, which a browser drops.
 *
 * Nothing reaches it with a NaN today: `computePvpProgress` refuses a
 * non-finite anchor and `parseWorkspace` defaults every number. But `meter` is a
 * public prop on a composition fifteen widget types draw through, and "the wall
 * goes blank" is not a failure mode to leave one arithmetic slip away.
 */
export function meterPct(fraction: number): number {
  return Number.isFinite(fraction) ? Math.min(100, Math.max(0, fraction * 100)) : 0;
}

/** Where the fill was last put, and what it was measuring at the time. */
export interface MeterSample {
  /** Identity of the thing being measured — see `meterKey` on ReadoutProps. */
  key: string | null;
  /** 0..100. */
  pct: number;
}

/**
 * May the fill GLIDE from `prev` to `pct`, or must it snap?
 *
 * Snaps on the three discontinuities, each of which a glide would misdraw:
 *
 *  - **First paint.** There is nothing to glide from, and starting every bar at
 *    zero would animate a second of progress that never happened.
 *  - **A different thing.** The clip changed, the cue advanced, the operator
 *    pointed the widget at another layer. The old fraction and the new one are
 *    measurements of two different clips and nothing connects them.
 *  - **A jump.** Backwards is a scrub, a restart or a loop — glided, the bar
 *    slides BACKWARDS across the widget for a second, which reads as a bug
 *    rather than as a rewind. Far enough forwards is a seek or a woken display.
 *
 * "Backwards" is qualified by METER_DRIFT_PCT. The server re-anchors whenever
 * the clip drifts past a second, and a correction landing a hair behind where
 * the client had interpolated to is a retreat of a hundredth of a percent on a
 * long clip — treated as a discontinuity, that stalls a smooth bar for a whole
 * second to correct something a fraction of a pixel wide.
 *
 * A PAUSED clip needs no case of its own: `computePvpProgress` multiplies by
 * `playbackRate`, so at rate 0 the fraction is identical every tick, the width
 * never changes, and there is nothing for a transition to animate. The bar holds
 * where it is rather than creeping toward a next value it was never given.
 */
export function meterSmooth(prev: MeterSample | null, key: string | null, pct: number): boolean {
  if (prev === null) return false;
  if (prev.key !== key) return false;
  if (pct < prev.pct - METER_DRIFT_PCT) return false;
  return pct - prev.pct <= METER_SNAP_JUMP_PCT;
}

/**
 * The rule's fill, which GLIDES to each new value rather than stepping to it.
 *
 * Its own component because the decision needs the PREVIOUS value and the rule
 * is drawn conditionally — a hook inside that condition would be a hook that
 * sometimes runs.
 *
 * Which value it glides to is CSS's problem, not React's: the component writes
 * the two ends and the browser draws every frame between them, so a wall
 * display's smooth bar costs exactly the one render a second it already did.
 * Emphatically not requestAnimationFrame, which would be sixty renders a second
 * per widget for a two-pixel hairline, on hardware that is often a Pi.
 *
 * Everything this decides — the width and how long to take reaching it — is
 * written in ONE React commit. See the style object for why that matters.
 */
export function MeterFill({
  fraction,
  seriesKey,
  fill,
}: {
  /** 0..1. Clamped here, and here only — see `meterPct`. */
  fraction: number;
  seriesKey: string | null;
  fill: string;
}) {
  const pct = meterPct(fraction);
  // State adjusted during render, which is React's own answer to "this render
  // needs to know what the last one was" — not a ref, which cannot be read here,
  // and not an effect, which would be a frame too late (see the style object).
  //
  // The set below re-runs this component immediately and throws the current
  // render away, so the DOM is written ONCE, with the answer already in it. It
  // cannot loop: the second pass finds the sample it just stored and skips —
  // which is exactly why `meterPct` must never return NaN, since NaN is the one
  // value that is not equal to the sample it was just stored as.
  const [sample, setSample] = useState<MeterSample & { smooth: boolean }>(() => ({
    key: seriesKey,
    pct,
    smooth: false,
  }));
  if (sample.key !== seriesKey || sample.pct !== pct) {
    setSample({ key: seriesKey, pct, smooth: meterSmooth(sample, seriesKey, pct) });
  }
  const smooth = sample.key === seriesKey && sample.pct === pct && sample.smooth;
  return (
    <span
      className="su-meter-fill"
      style={{
        display: "block",
        height: "100%",
        borderRadius: "inherit",
        width: `${pct}%`,
        background: fill,
        // THE DURATION TRAVELS WITH THE WIDTH, in one React commit.
        //
        // It was written from a layout effect first, and that is a frame too
        // late: React mutates the DOM for the WHOLE tree before it runs any
        // layout effect, and `useShrinkToWidth` in readout.tsx reads
        // `scrollWidth` in one of those — a forced style recalculation, which
        // resolves the new width against the duration still standing from the
        // last tick and starts the transition there and then. Watched against a
        // real ProVideoPlayer: at a cue change the property was correctly set to
        // 0ms and the bar slid from 90% back to 3% over a full second anyway.
        //
        // Through a custom property rather than straight into the shorthand so
        // the reduced-motion rule in styles.css can defer to this instead of
        // overriding it: a blanket `transition-duration: 1ms !important` there
        // would put the once-a-second stepping back, and would also make a snap
        // indistinguishable from a glide.
        "--su-meter-ms": smooth ? `${METER_TICK_MS}ms` : "0ms",
        // WIDTH rather than a transform, knowingly. `transform: scaleX` is the
        // cheaper property and would be right for a plain block, but this rule
        // is a PILL: its border-radius is its own height, and scaling the box
        // horizontally squashes the rounded cap into an ellipse — invisible on
        // the 2px minimum and obvious on the 15px rule a 1080px-tall widget
        // draws. One hairline per ProVideoPlayer widget, for one second an
        // update, is a cost worth the cap staying round.
        transition: "width var(--su-meter-ms, 0ms) linear",
      } as CSSProperties}
    />
  );
}

