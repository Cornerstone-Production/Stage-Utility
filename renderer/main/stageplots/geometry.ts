// geometry.ts — the editor's geometry, pure: resizing a rotated item in its own
// frame, snapping a rotation, and keeping an item inside the plot so the draft
// is always something the server accepts (stageplots-store checkItems).

import { clamp, round1 } from "@main/services/clamp";
import { withCableBox } from "@main/services/stageplots-doc";
import { PLOT_UNITS_WIDE, STAGEPLOT_LIMITS, type CablePoint, type PlotItem } from "@main/types/stageplots";

export { round1, withCableBox };

const { itemMinSize: MIN, itemMaxSize: MAX } = STAGEPLOT_LIMITS;

/**
 * `v` to a tenth of a unit, held within [lo, hi]. Rounded FIRST: clamped and
 * then rounded, a value at the bottom of a plot 666.666… high comes out 666.7,
 * outside it, and the draft can no longer be saved.
 */
export function within1(v: number, lo: number, hi: number): number {
  return clamp(round1(v), lo, hi);
}

/** An angle in degrees, brought into (-180, 180]. */
export function normalizeAngle(deg: number): number {
  const a = ((deg % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

/** An angle snapped to the nearest 5°, within (-180, 180]. */
export function snapRotation(deg: number): number {
  return normalizeAngle(Math.round(deg / 5) * 5);
}

/** The angle, in degrees, from an item's centre to a point: 0 straight up, clockwise. */
export function angleTo(it: Pick<PlotItem, "x" | "y" | "w" | "h">, p: { x: number; y: number }): number {
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  return (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
}

/**
 * The box an item takes when its corner handle is dragged to `pointer`: resized
 * about its centre, in its own rotated frame, so a rotated item grows along its
 * own sides rather than the screen's. `pad` is the gap between the item and its
 * handle, taken off so the handle stays under the pointer. A dimension line
 * keeps its height. Never smaller than the 8-unit minimum.
 */
export function resizeInFrame(it: PlotItem, pointer: { x: number; y: number }, pad = 0): Pick<PlotItem, "x" | "y" | "w" | "h"> {
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  const a = (-it.rotation * Math.PI) / 180;
  const vx = pointer.x - cx;
  const vy = pointer.y - cy;
  const lx = vx * Math.cos(a) - vy * Math.sin(a);
  const ly = vx * Math.sin(a) + vy * Math.cos(a);
  const w = within1(2 * Math.abs(lx) - 2 * pad, MIN, MAX);
  const h = it.type === "text" && it.textKind === "dimension" ? it.h : within1(2 * Math.abs(ly) - 2 * pad, MIN, MAX);
  return { x: round1(cx - w / 2), y: round1(cy - h / 2), w, h };
}

/** A point inside a plot `height` units high, to a tenth. */
export function clampPoint(p: { x: number; y: number }, height: number): CablePoint {
  return [within1(p.x, 0, PLOT_UNITS_WIDE), within1(p.y, 0, height)];
}

/**
 * An item made saveable on a plot `height` units high: sizes within 8 to 1000,
 * kept wholly on the plot where it fits (its top-left inside it always),
 * rotation within (-180, 180], a cable's points inside and its box theirs.
 */
export function fitItem(it: PlotItem, height: number): PlotItem {
  if (it.type === "cable") return withCableBox({ ...it, points: (it.points ?? []).map(([x, y]) => clampPoint({ x, y }, height)) });
  const w = within1(it.w, MIN, MAX);
  const h = within1(it.h, MIN, MAX);
  return {
    ...it,
    w,
    h,
    x: within1(it.x, 0, Math.max(0, PLOT_UNITS_WIDE - w)),
    y: within1(it.y, 0, Math.max(0, height - h)),
    rotation: normalizeAngle(it.rotation),
  };
}
