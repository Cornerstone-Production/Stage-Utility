// Draw a box where the widget goes, then say what it is.
//
// The other way round from the toolbar dropdown, which adds at a fixed spot and
// leaves you to drag and resize it to where you actually wanted it.
//
// Pure: two points in canvas fractions, out comes the rect to create.
//
// This gesture does NOT take a plain drag on empty canvas. That already means
// marquee selection, and this phase does not change existing behaviour. It is
// reached from a toolbar toggle instead of a held modifier, because both
// obvious modifiers are already spoken for: Alt suppresses snapping and Shift
// extends a selection.

import { clamp } from "@main/services/clamp";
import type { FracRect } from "../main/layout-tree";

/** Smaller than this in either axis and it was a click, not a drawn box. */
export const MIN_DRAW = 0.04;

/** What a too-small drag becomes instead — the same default the toolbar uses. */
const FALLBACK_W = 0.3;
const FALLBACK_H = 0.16;

/**
 * The rect between two points.
 *
 * Normalised, so dragging up-and-left produces the same rectangle as dragging
 * down-and-right — an operator who starts at the bottom right is not doing
 * something different, and a negative width is never what they meant.
 *
 * A drag under the minimum becomes a default-sized widget anchored at the start
 * point, so a click still adds something usable rather than a 2px sliver nobody
 * can select.
 */
export function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): FracRect {
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  let x = Math.min(a.x, b.x);
  let y = Math.min(a.y, b.y);

  if (w < MIN_DRAW || h < MIN_DRAW) {
    w = FALLBACK_W;
    h = FALLBACK_H;
    x = a.x - w / 2;
    y = a.y - h / 2;
  }

  w = Math.min(w, 1);
  h = Math.min(h, 1);
  return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h };
}
