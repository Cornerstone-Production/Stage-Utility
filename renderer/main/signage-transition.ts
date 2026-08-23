// signage-transition.ts — how a transition is DECLARED, not interpolated.
//
// PURE: a transition in, inline styles out. No timers, no refs, no DOM, so every
// shape is testable and the player only has to decide WHEN.
//
// WHY THIS IS NOT A PROGRESS FUNCTION ANY MORE. It used to take a 0-to-1
// progress and return the styles at that instant, which meant the interpolation
// happened in React's render. The player is a pure function of a clock that
// ticks every 100ms, so a 600ms crossfade was six opacity steps — reported, from
// a wall, as "the crossfade is choppy and sucks". Ticking faster is not the fix:
// it would re-render a still image sixty times a second on a Pi for the 99% of
// the time nothing is moving.
//
// So the styles here are STATIC for a given transition, and the browser runs the
// animation. React mounts a layer; the compositor moves it at the display's own
// refresh rate. Static also matters mechanically: mutating an animation property
// on a running animation restarts it, so a per-tick delay would have replaced a
// six-step fade with a fade that stuttered ten times a second.
//
// THE CONSTRAINT, unchanged: only `opacity` and `transform` are ever animated.
// Those two are composited on the GPU; anything else — clip-path, filter, width,
// left — forces a full repaint every frame, and a Pi 4 driving 1080p cannot hold
// 60fps through that. `wipe` is therefore a translating overlay rather than the
// animated clip-path it obviously wants to be.

import type { CSSProperties } from "react";
import type { SignageDirection, SignageTransition } from "@main/types/signage";

/** What the player should mount, and what the compositor should do with it. */
export interface TransitionPlan {
  /** Keep the previous item underneath for the transition's duration. */
  showOutgoing: boolean;
  /**
   * Change the item at the HALFWAY point rather than at the start.
   *
   * Only fade-through-black: the swap has to happen while the veil is opaque, or
   * the audience sees the cut through it.
   */
  swapAtMidpoint: boolean;
  incoming: CSSProperties;
  outgoing: CSSProperties;
  /** A black sheet over both. Null for every kind but fade-through-black. */
  veil: CSSProperties | null;
}

/** Slide/wipe with no direction stored. Old records will not have one, and
 *  treating that as a cut would silently disable the transition. */
const DEFAULT_DIRECTION: SignageDirection = "left";

/** Where a layer starts (incoming) or ends (outgoing), as an x/y pair. */
function travel(dir: SignageDirection, sign: number): { dx: string; dy: string } {
  switch (dir) {
    case "left": return { dx: `${sign * 100}%`, dy: "0" };
    case "right": return { dx: `${-sign * 100}%`, dy: "0" };
    case "up": return { dx: "0", dy: `${sign * 100}%` };
    case "down": return { dx: "0", dy: `${-sign * 100}%` };
  }
}

/**
 * The animation declaration shared by every moving layer.
 *
 * `linear`, deliberately. An eased crossfade between two full-bleed graphics
 * spends its ease at the ends, where both images are near-opaque, and reads as a
 * hesitation rather than as easing.
 *
 * `both` fill, so a layer holds its start state before the first frame and its
 * end state after the last — without it, a mounted layer flashes at full opacity
 * for one frame before the fade begins.
 */
function run(name: string, ms: number): CSSProperties {
  return {
    animationName: name,
    animationDuration: `${ms}ms`,
    animationTimingFunction: "linear",
    animationFillMode: "both",
    // Promotes the layer to its own compositor surface BEFORE the animation
    // starts. Without it the first frame is where the promotion happens, which
    // is the one visible hitch left once the interpolation moves off the main
    // thread.
    willChange: "opacity, transform",
  };
}

const STILL: CSSProperties = { opacity: 1 };
const HIDDEN: CSSProperties = { opacity: 0 };

/**
 * What to mount for `t`, and what the browser should animate.
 *
 * Depends only on the transition, never on how far through it we are — see the
 * header for why that is the whole point.
 */
export function transitionPlan(t: SignageTransition): TransitionPlan {
  const dir = t.direction ?? DEFAULT_DIRECTION;

  // A zero-length transition of any kind is a cut. Running a 0ms animation is a
  // frame of flicker for no reason.
  if (t.kind === "cut" || t.ms <= 0) {
    return { showOutgoing: false, swapAtMidpoint: false, incoming: STILL, outgoing: HIDDEN, veil: null };
  }

  switch (t.kind) {
    case "crossfade":
      return {
        showOutgoing: true,
        swapAtMidpoint: false,
        incoming: run("signage-fade-in", t.ms),
        outgoing: run("signage-fade-out", t.ms),
        veil: null,
      };

    case "fade-through-black":
      // Neither layer animates: the veil does all the work, and the item swaps
      // underneath it at the midpoint. Cross-fading as well would show a ghost
      // of both through the black.
      return {
        showOutgoing: false,
        swapAtMidpoint: true,
        incoming: STILL,
        outgoing: HIDDEN,
        veil: { ...run("signage-veil", t.ms), background: "#000" },
      };

    case "slide": {
      // Both move together, as though the second pushed the first out.
      const inTravel = travel(dir, 1);
      const outTravel = travel(dir, -1);
      return {
        showOutgoing: true,
        swapAtMidpoint: false,
        incoming: { ...run("signage-slide-in", t.ms), "--signage-dx": inTravel.dx, "--signage-dy": inTravel.dy } as CSSProperties,
        outgoing: { ...run("signage-slide-out", t.ms), "--signage-dx": outTravel.dx, "--signage-dy": outTravel.dy } as CSSProperties,
        veil: null,
      };
    }

    case "wipe": {
      // Only the incoming layer moves, revealing itself over a stationary one.
      const inTravel = travel(dir, 1);
      return {
        showOutgoing: true,
        swapAtMidpoint: false,
        incoming: { ...run("signage-slide-in", t.ms), "--signage-dx": inTravel.dx, "--signage-dy": inTravel.dy } as CSSProperties,
        outgoing: STILL,
        veil: null,
      };
    }
  }
}
