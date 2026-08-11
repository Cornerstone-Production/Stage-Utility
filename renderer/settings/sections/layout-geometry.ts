// layout-geometry.ts — the maths behind dragging and resizing on the layout canvas.
//
// Lifted out of layout-editor.tsx, which is 3,100 lines of component. None of
// this touches React or the DOM: it is fractions in, fractions out. Kept in one
// place so it can be tested directly, because it is the kind of code that goes
// subtly wrong — a resize that drifts by a pixel per drag, an object that escapes
// the canvas edge, a nested object snapping to a different grid than the one
// drawn under it.
//
// Everything is in FRACTIONS of the canvas (0..1), not pixels, so a layout looks
// the same on a 1080p stage screen and a 4K one.

import { composeRect, localizeRect, type FracRect } from "../../main/layout-tree";
// Re-exported below, not redefined — see main/services/clamp.ts.
import { clamp } from "@main/services/clamp";

/** Snap steps across the canvas. A finer grid means roughly half-size cells. */
export const GRID = 96;

/** The smallest an object may be dragged, as a fraction of the canvas. */
export const MIN = 0.03;

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Re-exported so everything already importing clamp from this module is
 *  untouched; the implementation is shared with the backend. */
export { clamp };

/**
 * Grid step per axis.
 *
 * x is a plain fraction of width; y is scaled by the rendered box aspect so a
 * cell is the same number of pixels on both axes — a square grid whatever shape
 * the canvas is. Deriving it from the rendered box rather than the design size
 * is what keeps snapping aligned to the grid actually drawn, whether the canvas
 * is letterboxed or filling the window.
 */
export function gridUnits(boxW: number, boxH: number): { xUnit: number; yUnit: number } {
  return { xUnit: 1 / GRID, yUnit: boxH > 0 ? boxW / boxH / GRID : 1 / GRID };
}

export const snapTo = (v: number, unit: number): number => Math.round(v / unit) * unit;

/**
 * Snap a parent-local rect to the grid.
 *
 * Composes to absolute canvas space, snaps there, then converts back — so an
 * object nested in a container lands on the same visible lines as a top-level
 * one, rather than on a grid relative to its parent.
 */
export function snapRectToGrid(
  local: FracRect,
  parentAbs: FracRect,
  boxW: number,
  boxH: number,
  size: boolean,
): FracRect {
  const { xUnit, yUnit } = gridUnits(boxW, boxH);
  const abs = composeRect(parentAbs, local);
  const snapped = {
    x: snapTo(abs.x, xUnit),
    y: snapTo(abs.y, yUnit),
    w: size ? Math.max(xUnit, snapTo(abs.w, xUnit)) : abs.w,
    h: size ? Math.max(yUnit, snapTo(abs.h, yUnit)) : abs.h,
  };
  return localizeRect(parentAbs, snapped);
}

/** The CSS cursor for a resize handle. */
export function handleCursor(h: Handle): string {
  if (h === "n" || h === "s") return "ns-resize";
  if (h === "e" || h === "w") return "ew-resize";
  if (h === "nw" || h === "se") return "nwse-resize";
  return "nesw-resize";
}

/**
 * Where a rect ends up after dragging `handle` by (dx, dy).
 *
 * Three rules, applied in order, and the order is the subtle part:
 *   1. The dragged edges move; the opposite edges stay put.
 *   2. Nothing shrinks below MIN — and when dragging a top or left edge, the
 *      position is pinned so the object does not slide once it stops shrinking.
 *   3. Nothing escapes the canvas.
 */
export function applyResize(
  start: FracRect,
  handle: Handle,
  dx: number,
  dy: number,
): FracRect {
  let { x, y, w, h: hh } = start;

  if (handle.includes("e")) w = start.w + dx;
  if (handle.includes("s")) hh = start.h + dy;
  if (handle.includes("w")) {
    x = start.x + dx;
    w = start.w - dx;
  }
  if (handle.includes("n")) {
    y = start.y + dy;
    hh = start.h - dy;
  }

  if (w < MIN) {
    if (handle.includes("w")) x = start.x + start.w - MIN;
    w = MIN;
  }
  if (hh < MIN) {
    if (handle.includes("n")) y = start.y + start.h - MIN;
    hh = MIN;
  }

  x = clamp(x, 0, 1 - w);
  y = clamp(y, 0, 1 - hh);
  w = Math.min(w, 1 - x);
  hh = Math.min(hh, 1 - y);
  return { x, y, w, h: hh };
}

/**
 * A solid `#rrggbb` for a native colour input.
 *
 * `<input type="color">` accepts nothing else, but a stored style colour can be
 * a translucent `rgba()` (the glass presets), `#rgb`, `#rrggbbaa`, a `var()`, or
 * a named colour. Coerced here — dropping alpha — so the swatch has something
 * valid to show. The stored style keeps its original value until the user picks
 * a new one.
 */
export function hexForInput(v: string | null | undefined, fallback: string): string {
  if (!v) return fallback;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;

  const m3 = v.match(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;

  const m8 = v.match(/^#([0-9a-fA-F]{6})[0-9a-fA-F]{2}$/);
  if (m8) return `#${m8[1]}`;

  const rgb = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    const h = (n: number) => clamp(n, 0, 255).toString(16).padStart(2, "0");
    return `#${h(+rgb[1])}${h(+rgb[2])}${h(+rgb[3])}`;
  }
  return fallback;
}
