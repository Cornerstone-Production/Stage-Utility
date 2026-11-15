// Where a drag over the context bar lands, from the pointer and the readings'
// boxes: geometry rather than droppables, because closestCenter's `over` is
// never null, so nothing could ever be dropped OUT. The arithmetic is here,
// where it can be tested.

import { dropPoint, pointInBox, type Box, type DragEndGeometry } from "./drag-geometry";

/**
 * Did the drag finish over the bar?
 *
 * `pad` is for the bar's own thinness — 44px is an easy thing to wobble out of
 * while aiming at it, and every pixel outside it deletes an item.
 *
 * Answers TRUE when there is no pointer to judge by: with nothing to go on,
 * keeping the item is recoverable and deleting it on a guess is not. Answers
 * FALSE when there is no bar.
 */
export function droppedOnBar(e: DragEndGeometry, bar: Box | null, pad = 16): boolean {
  const p = dropPoint(e);
  if (!p) return true;
  // NO BAR IS NOT A PLACE. A page with no context bar (a console without the
  // app's chrome) has no strip to measure, and answering "on the bar" there put
  // a dropped tile into an empty arrangement and saved it over the whole bar.
  if (!bar) return false;
  return pointInBox(bar, p, pad);
}

/**
 * Which gap the pointer sits in, given the midpoints of the rows STAYING PUT.
 *
 * Midpoints, not "the row you are over": hovering the right half of a wide item
 * means you want to be after it, and an over-based rule cannot tell the two
 * halves apart — it inserted before the row every time, which read as a stubborn
 * bias to the left. It also removes the reorder/insert asymmetry entirely: the
 * dragged row is excluded from `mids`, so there is one rule and no off-by-one.
 *
 * `mids` must be in display order. Returns 0..mids.length.
 */
export function gapFromMidpoints(mids: readonly number[], x: number): number {
  let gap = 0;
  for (const m of mids) {
    if (x <= m) break;
    gap++;
  }
  return gap;
}

/** A reading measured at the start of a drag. */
export interface MeasuredRow {
  key: string;
  box: Box;
  /** The one being dragged: left out of the count, kept for its line. */
  dragged?: boolean;
}

/**
 * Which gap the pointer sits in, among rows that may WRAP onto several lines.
 *
 * The editing strip wraps when it runs out of room, and a midpoint along x alone
 * cannot tell a row on the first line from one under it. So the rows are read
 * as lines: the pointer's line is the first one whose bottom is below it (or the
 * last), and within that line it is the midpoint rule, gapFromMidpoints.
 *
 * The dragged row is counted for its LINE but not for the gap: a chip alone on
 * the last line, let go where it sits, must find that line rather than fall back
 * to the one above and jump to the front. Returns 0..(rows not dragged).
 */
export function gapFromBoxes(rows: readonly MeasuredRow[], p: { x: number; y: number }): number {
  const lines: { before: number; rows: MeasuredRow[]; bottom: number }[] = [];
  let staying = 0;
  for (const r of rows) {
    const line = lines.at(-1);
    // A row that starts below the current line's middle starts a new line.
    if (line && r.box.top < (line.rows[0].box.top + line.rows[0].box.bottom) / 2) {
      line.rows.push(r);
      line.bottom = Math.max(line.bottom, r.box.bottom);
    } else {
      lines.push({ before: staying, rows: [r], bottom: r.box.bottom });
    }
    if (!r.dragged) staying++;
  }
  if (lines.length === 0) return 0;
  const line = lines.find((l) => p.y <= l.bottom) ?? lines[lines.length - 1];
  const mids = line.rows.filter((r) => !r.dragged).map((r) => (r.box.left + r.box.right) / 2);
  return line.before + gapFromMidpoints(mids, p.x);
}
