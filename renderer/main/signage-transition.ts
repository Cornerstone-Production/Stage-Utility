// signage-transition.ts — the two layers' styles, part-way through a transition.
//
// PURE: a kind and a progress in, inline styles out. No timers, no refs, no DOM,
// so every shape is testable and the player only has to decide WHEN.
//
// THE CONSTRAINT: only `opacity` and `transform` are ever animated. Those two are
// composited on the GPU; anything else — clip-path, filter, width, left — forces
// a full repaint every frame, and a Pi 4 driving 1080p cannot hold 60fps through
// that. It looks worse than a cut, which defeats the point of having chosen a
// transition at all. `wipe` is therefore a translating overlay rather than the
// animated clip-path it obviously wants to be.

import type { CSSProperties } from "react";
import type { SignageDirection, SignageTransition } from "@main/types/signage";

export interface LayerStyles {
  /** The item coming in. Sits above the outgoing one. */
  incoming: CSSProperties;
  /** The item going out. */
  outgoing: CSSProperties;
  /** A black sheet over both, for "fade through black". 0 the rest of the time. */
  veilOpacity: number;
}

/** Slide/wipe with no direction stored. Old records will not have one, and
 *  treating that as a cut would silently disable the transition. */
const DEFAULT_DIRECTION: SignageDirection = "left";

/** Offscreen offset for a layer, in the direction things travel. */
function offset(dir: SignageDirection, sign: number): string {
  switch (dir) {
    case "left": return `translateX(${sign * 100}%)`;
    case "right": return `translateX(${-sign * 100}%)`;
    case "up": return `translateY(${sign * 100}%)`;
    case "down": return `translateY(${-sign * 100}%)`;
  }
}

/**
 * Both layers, `progress` of the way through.
 *
 * `progress` is clamped to [0, 1] rather than extrapolated: a frame that arrives
 * late must not overshoot into an offset that never resolves, which on a wall
 * screen is permanent.
 */
export function layerStyles(t: SignageTransition, progress: number): LayerStyles {
  const p = Math.min(1, Math.max(0, progress));
  const dir = t.direction ?? DEFAULT_DIRECTION;

  switch (t.kind) {
    case "cut":
      return { incoming: { opacity: 1 }, outgoing: { opacity: 0 }, veilOpacity: 0 };

    case "crossfade":
      return { incoming: { opacity: p }, outgoing: { opacity: 1 - p }, veilOpacity: 0 };

    case "fade-through-black":
      // Both layers stay fully opaque; the veil does all the work, and the swap
      // happens at the midpoint while it is opaque. Cross-fading underneath as
      // well would show a ghost of both through the black.
      return {
        incoming: { opacity: p >= 0.5 ? 1 : 0 },
        outgoing: { opacity: p >= 0.5 ? 0 : 1 },
        veilOpacity: p <= 0.5 ? p * 2 : (1 - p) * 2,
      };

    case "slide":
      // Both move together, as though the second pushed the first out.
      return {
        incoming: { opacity: 1, transform: p >= 1 ? "none" : lerp(offset(dir, 1), p) },
        outgoing: { opacity: 1, transform: lerp(offset(dir, -1), 1 - p) },
        veilOpacity: 0,
      };

    case "wipe":
      // Only the incoming layer moves, revealing itself over a stationary one.
      return {
        incoming: { opacity: 1, transform: p >= 1 ? "none" : lerp(offset(dir, 1), p) },
        outgoing: { opacity: 1, transform: "none" },
        veilOpacity: 0,
      };
  }
}

/**
 * A percentage transform scaled toward zero as `p` goes to 1.
 *
 * Written as string surgery rather than by rebuilding the transform, so the
 * direction logic lives in exactly one place (`offset`) and cannot disagree with
 * itself between the two call sites.
 */
function lerp(transform: string, p: number): string {
  return transform.replace(/(-?\d+(?:\.\d+)?)%/, (_, n: string) => `${Number(n) * (1 - p)}%`);
}
