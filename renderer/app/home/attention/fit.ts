// How much of Needs attention fits in the box it was given.
//
// The card is a fixed box that never scrolls and never draws over itself, so what
// does not fit is left out, and said so: whole rows, then "+N more". Every part
// has ONE fixed height here, and the markup sets exactly that height, so this
// arithmetic is the layout rather than an estimate of it. Pure, because jsdom
// reports every box as 0x0 and the part that has to be right is the arithmetic.

/** The "Needs attention · N" line. */
export const HEADER_PX = 32;
/** One problem: title, reason and its buttons. */
export const ROW_PX = 52;
/** The "+N more" line. */
export const MORE_PX = 28;
/** The healthy line, one line, beneath the list. */
export const STRIP_PX = 36;

/** Rows drawn before the box has been measured, so the first frame is not blank. */
export const UNMEASURED_ROWS = 3;

// The all-clear tile, which has no rows: the box height at which each of its
// lines joins the headline, in the order a shrinking box drops them.
/** The "Needs attention" caption above "All clear". */
export const CLEAR_CAPTION_MIN_PX = 56;
/** The healthy line beneath it. */
export const CLEAR_HEALTHY_MIN_PX = 84;
/** "Show N snoozed" beneath that. */
export const CLEAR_TOGGLE_MIN_PX = 112;

/** Whether a box `h` tall has room for a part that needs `min`. A box not
 *  measured yet (0, and all a DOM with no layout reports) shows it. */
export function roomFor(h: number, min: number): boolean {
  return h <= 0 || h >= min;
}

/** What the buttons on a row look like at this width. */
export type RowButtons = "full" | "compact" | "fix" | "none";

/** The size a row's buttons are drawn at: full size only when both fit at it. */
export function buttonSize(buttons: RowButtons): "medium" | "small" {
  return buttons === "full" ? "medium" : "small";
}

/**
 * Wide enough for Snooze and the fix at full size, then both small, then the fix
 * alone, then neither. The text beside them is truncated at every width, so a
 * button is only ever dropped for the room it takes from the title.
 */
export function buttonsFor(width: number): RowButtons {
  if (width <= 0 || width >= 440) return "full";
  if (width >= 340) return "compact";
  if (width >= 240) return "fix";
  return "none";
}

export interface AttentionFit {
  /** Whole rows to draw. */
  rows: number;
  /** Whether the healthy line has room. */
  strip: boolean;
}

/**
 * `height` is the box, `count` the rows there are to show (a snoozed row counts
 * while it is open), `wantStrip` whether there is anything for the healthy line
 * to say. A failure note costs nothing here: it is drawn in the header line.
 *
 * Prefers the healthy line when at least one row can sit beside it, and drops
 * the line rather than the list when only one of them can. Never returns more
 * than fits: a box too short for even a row gets the header alone, whose own
 * count still says how many there are.
 */
export function fitAttention(height: number, count: number, wantStrip: boolean): AttentionFit {
  // Not measured yet (or no layout at all): a plain default, never a guess that
  // draws nothing.
  if (height <= 0) return { rows: Math.min(count, UNMEASURED_ROWS), strip: wantStrip };
  const budget = height - HEADER_PX;
  if (wantStrip) {
    // With the strip: kept when a row sits beside it, or when there is no row to
    // show and the strip itself fits.
    const rows = rowsIn(budget - STRIP_PX, count);
    if (rows >= 1 || (count === 0 && budget - STRIP_PX >= 0)) return { rows, strip: true };
  }
  // Without it: every row there is room for, which may be none (the header alone).
  return { rows: rowsIn(budget, count), strip: false };
}

/** Whole rows of `count` in `budget`, with the "+N more" line when any are left out. */
function rowsIn(budget: number, count: number): number {
  let rows = count;
  while (rows > 0 && rows * ROW_PX + (rows < count ? MORE_PX : 0) > budget) rows--;
  return rows;
}
