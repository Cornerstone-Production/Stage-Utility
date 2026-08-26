// Where a widget lands when you drop it on the canvas.
//
// Pure: a drop point in canvas fractions, out comes the rect to create. No React,
// no DOM — the same reason layout-geometry.ts is separate, and the same contract.
//
// Nothing here changes how existing placement works. Dragging an object that is
// already on the canvas, resizing it, and adding one from the toolbar dropdown
// all go through the paths they always did.

import { clamp } from "@main/services/clamp";
import type { FracRect } from "../main/layout-tree";

/**
 * Default size for a newly dropped widget, as a fraction of the canvas.
 *
 * Matches what the Add-object dropdown has always produced, so a widget placed
 * from the palette and one added from the toolbar are the same size. Two ways in
 * that disagree about the result would be worse than one way in.
 */
export const DROP_W = 0.3;
export const DROP_H = 0.16;

/** A container is a frame for other things, so it starts bigger — again matching
 *  what the existing add path does. */
export const DROP_CONTAINER_W = 0.4;
export const DROP_CONTAINER_H = 0.32;

export function defaultDropSize(isContainer: boolean): { w: number; h: number } {
  return isContainer
    ? { w: DROP_CONTAINER_W, h: DROP_CONTAINER_H }
    : { w: DROP_W, h: DROP_H };
}

/**
 * The rect for a widget dropped at `point`.
 *
 * Centred on the pointer, because that is where the operator is looking — a rect
 * whose top-left corner is at the cursor lands visibly below and right of where
 * they aimed, and every drop needs a corrective nudge.
 *
 * Then clamped fully inside the canvas. Dropping near an edge is normal (a corner
 * is where you want a clock), and a widget half off the canvas is never what was
 * meant.
 */
export function rectForDrop(
  point: { x: number; y: number },
  size: { w: number; h: number },
): FracRect {
  const w = Math.min(size.w, 1);
  const h = Math.min(size.h, 1);
  return {
    x: clamp(point.x - w / 2, 0, 1 - w),
    y: clamp(point.y - h / 2, 0, 1 - h),
    w,
    h,
  };
}

/**
 * The same rect expressed inside a container.
 *
 * `parentAbs` is the container's absolute canvas rect. A widget dropped onto a
 * container is stored in the container's coordinates, so the maths has to move
 * with it — otherwise the child renders somewhere else entirely the moment the
 * container is moved.
 */
export function localiseToParent(abs: FracRect, parentAbs: FracRect): FracRect {
  if (parentAbs.w <= 0 || parentAbs.h <= 0) return abs;
  const w = Math.min(abs.w / parentAbs.w, 1);
  const h = Math.min(abs.h / parentAbs.h, 1);
  return {
    x: clamp((abs.x - parentAbs.x) / parentAbs.w, 0, 1 - w),
    y: clamp((abs.y - parentAbs.y) / parentAbs.h, 0, 1 - h),
    w,
    h,
  };
}
