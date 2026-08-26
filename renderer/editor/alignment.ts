// alignment.ts — snapping an object to the OTHER objects, rather than to the grid.
//
// The 96-cell grid in layout-geometry.ts answers "line this up with the grid".
// It cannot answer "line this up with THAT object", which is what an operator
// actually wants when a row of tiles must share a top edge — and a grid fine
// enough to make that likely is too fine to be useful.
//
// Pure: fractions in, fractions out, plus the guides the caller should draw. No
// React, no DOM. The one piece of pixel awareness is the tolerance, and that is
// deliberate: see below.
//
// Everything is ABSOLUTE canvas space (0..1 of the whole canvas), never relative
// to a parent container, so an object nested two deep snaps to the same visible
// lines as a top-level one.

import type { FracRect } from "../main/layout-tree";
import { MIN, type Handle } from "../settings/sections/layout-geometry";

export interface Guide {
  axis: "x" | "y";
  /** Canvas-space fraction of the line. */
  at: number;
  /** Perpendicular extent to draw, so a guide spans only what it relates. */
  span: { from: number; to: number };
  kind: "edge" | "center" | "gap";
}

export interface AlignResult {
  rect: FracRect;
  guides: Guide[];
}

/** Two rects overlap on the axis PERPENDICULAR to the one being aligned. Without
 *  this, an object at the bottom of the canvas reports an "equal gap" with a row
 *  at the top, which is true arithmetically and meaningless on screen. */
function overlaps(a: FracRect, b: FracRect, axis: "x" | "y"): boolean {
  const [p, s] = axis === "x" ? (["y", "h"] as const) : (["x", "w"] as const);
  return a[p] < b[p] + b[s] && b[p] < a[p] + a[s];
}

interface Candidate {
  /** The line to snap to. */
  at: number;
  /** Distance from the moving edge to it. */
  d: number;
  /** Offset of the moving edge within the rect (0 = leading, w = trailing). */
  off: number;
  kind: "edge" | "center";
}

/**
 * The closest snap line on one axis, or null.
 *
 * `edges` is which of the moving rect's own edges may snap — all three when
 * moving, only the dragged one when resizing.
 */
function closest(
  r: FracRect,
  siblings: readonly FracRect[],
  axis: "x" | "y",
  tol: number,
  edges: { off: number }[],
): Candidate | null {
  const [p, s] = axis === "x" ? (["x", "w"] as const) : (["y", "h"] as const);

  const lines: { at: number; kind: "edge" | "center" }[] = [
    // The canvas itself: its edges and its middle.
    { at: 0, kind: "edge" },
    { at: 1, kind: "edge" },
    { at: 0.5, kind: "center" },
  ];
  for (const sib of siblings) {
    lines.push({ at: sib[p], kind: "edge" });
    lines.push({ at: sib[p] + sib[s], kind: "edge" });
    lines.push({ at: sib[p] + sib[s] / 2, kind: "center" });
  }

  // Ties are common and must not be broken by floating-point noise: an object
  // whose left edge is 3px from a sibling's left edge is, by construction, also
  // 3px from that sibling's centre and right edge. Without an epsilon the winner
  // is whichever accumulated the smaller rounding error, so the same drag snaps
  // to the edge on one canvas and the centre on another. Edges win ties, because
  // "line these up" means the edges far more often than it means the middles.
  const EPS = 1e-9;
  let best: Candidate | null = null;
  for (const e of edges) {
    const at = r[p] + e.off;
    for (const line of lines) {
      const d = Math.abs(at - line.at);
      if (d > tol) continue;
      const better =
        !best ||
        d < best.d - EPS ||
        (d < best.d + EPS && best.kind === "center" && line.kind === "edge");
      if (better) best = { at: line.at, d, off: e.off, kind: line.kind };
    }
  }
  return best;
}

/** How far the guide should reach: the moving rect plus everything sharing the line. */
function spanFor(
  r: FracRect,
  siblings: readonly FracRect[],
  axis: "x" | "y",
  at: number,
): { from: number; to: number } {
  const [p, s] = axis === "x" ? (["x", "w"] as const) : (["y", "h"] as const);
  const [q, t] = axis === "x" ? (["y", "h"] as const) : (["x", "w"] as const);
  let from = r[q];
  let to = r[q] + r[t];
  const EPS = 1e-6;
  for (const sib of siblings) {
    const touches =
      Math.abs(sib[p] - at) < EPS ||
      Math.abs(sib[p] + sib[s] - at) < EPS ||
      Math.abs(sib[p] + sib[s] / 2 - at) < EPS;
    if (!touches) continue;
    from = Math.min(from, sib[q]);
    to = Math.max(to, sib[q] + sib[t]);
  }
  return { from, to };
}

/**
 * The most common gap between neighbouring siblings on one axis, if there is one.
 *
 * Returns null when fewer than two siblings share the row, or when no gap repeats
 * — "equal spacing" with nothing to be equal to is not a thing to snap to.
 */
function commonGap(
  r: FracRect,
  siblings: readonly FracRect[],
  axis: "x" | "y",
  tol: number,
): { gap: number; before: number; after: number } | null {
  const [p, s] = axis === "x" ? (["x", "w"] as const) : (["y", "h"] as const);
  const row = siblings.filter((sib) => overlaps(r, sib, axis)).sort((a, b) => a[p] - b[p]);
  if (row.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 0; i < row.length - 1; i++) {
    gaps.push(row[i + 1][p] - (row[i][p] + row[i][s]));
  }
  // Every gap must agree, within tolerance. A row spaced 10/10/40 has no rhythm
  // to extend, and guessing one would move the object somewhere arbitrary.
  const gap = gaps[0];
  if (gap <= 0) return null;
  if (!gaps.every((g) => Math.abs(g - gap) <= tol)) return null;

  const last = row[row.length - 1];
  const first = row[0];
  return { gap, before: first[p] - gap, after: last[p] + last[s] + gap };
}

/**
 * Snap `moving` to its siblings and the canvas.
 *
 * `tolerancePx` is converted to a fraction PER AXIS from the rendered box, so the
 * pull is the same visual distance horizontally and vertically. A single fraction
 * tolerance pulls nearly twice as hard vertically on a 16:9 canvas, which feels
 * like the object is magnetised to one axis.
 *
 * `handle` is null for a move. During a resize only the dragged edge may snap,
 * and the rect is rebuilt from the anchored edge — translating it instead makes
 * the object creep across the canvas as it grows.
 */
export function alignRect(
  moving: FracRect,
  siblings: readonly FracRect[],
  box: { w: number; h: number },
  tolerancePx: number,
  handle: Handle | null,
  opts: { gaps?: boolean } = {},
): AlignResult {
  const rect: FracRect = { ...moving };
  const guides: Guide[] = [];
  if (box.w <= 0 || box.h <= 0) return { rect, guides };

  const tolX = tolerancePx / box.w;
  const tolY = tolerancePx / box.h;

  for (const axis of ["x", "y"] as const) {
    const [p, s] = axis === "x" ? (["x", "w"] as const) : (["y", "h"] as const);
    const tol = axis === "x" ? tolX : tolY;

    // Which of the moving rect's edges are in play.
    let edges: { off: number }[];
    if (!handle) {
      edges = [{ off: 0 }, { off: rect[s] }, { off: rect[s] / 2 }];
    } else {
      const lead = axis === "x" ? handle.includes("w") : handle.includes("n");
      const trail = axis === "x" ? handle.includes("e") : handle.includes("s");
      if (!lead && !trail) continue; // this axis is not being resized
      edges = lead ? [{ off: 0 }] : [{ off: rect[s] }];
    }

    const hit = closest(rect, siblings, axis, tol, edges);
    if (!hit) continue;

    if (!handle) {
      rect[p] = hit.at - hit.off;
    } else if (hit.off === 0) {
      // Dragging the leading edge: the trailing edge is anchored and must not move.
      const trailing = rect[p] + rect[s];
      // Never past the anchored edge. applyResize clamps to MIN and
      // snapRectToGrid to one grid unit, but BOTH run before this, and this
      // rebuilds the rect from the anchored edge with raw arithmetic -- so a snap
      // target beyond the far edge produced w = 0 and, measurably, w = -0.0015625.
      // Reachable whenever the rendered width is under the 8px tolerance: a
      // grid-minimum leaf inside a container a third of a ~700px canvas is 7.3px.
      // `width: -0.15%` is invalid, the box collapses with no grab area left to
      // undo it with, and the bad geometry is saved into the view.
      const at = Math.min(hit.at, trailing - MIN);
      rect[p] = at;
      rect[s] = trailing - at;
    } else {
      // Dragging the trailing edge: the leading edge is anchored.
      rect[s] = Math.max(MIN, hit.at - rect[p]);
    }

    guides.push({ axis, at: hit.at, kind: hit.kind, span: spanFor(rect, siblings, axis, hit.at) });
  }

  // Equal spacing, on a move only. Resizing to an equal gap is a different
  // gesture and would fight the edge snap above.
  if (!handle && opts.gaps !== false) {
    for (const axis of ["x", "y"] as const) {
      if (guides.some((g) => g.axis === axis)) continue; // an edge snap already won
      const [p, s] = axis === "x" ? (["x", "w"] as const) : (["y", "h"] as const);
      const tol = axis === "x" ? tolX : tolY;
      const cg = commonGap(rect, siblings, axis, tol);
      if (!cg) continue;

      const targets = [cg.after, cg.before - rect[s]];
      for (const target of targets) {
        if (Math.abs(rect[p] - target) > tol) continue;
        rect[p] = target;
        guides.push({
          axis,
          at: target,
          kind: "gap",
          span: spanFor(rect, siblings, axis, target),
        });
        break;
      }
    }
  }

  return { rect, guides };
}
