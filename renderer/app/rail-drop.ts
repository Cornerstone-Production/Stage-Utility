// Where a drag over the sidebar would land, from the pointer and the rows that
// hold still.
//
// The same approach as the context bar's (bar-drop.ts, whose header says why):
// no droppables and no sortable rows, only geometry. The rows are measured once
// when the drag starts, with the dragged one left out, and nothing shifts while
// the pointer aims. ONE function answers both "where is the caret" and "where
// does the drop go", so the caret cannot promise a place the drop does not keep.
//
// Positions are relative to the top of the rail's list, not the viewport, so the
// list scrolling under a drag does not invalidate what was measured.

/** What is being dragged. */
export interface RailDrag {
  kind: "row" | "head" | "tile";
  /** A page or console id, or a section id for a heading. */
  id: string;
}

/** What the pointer is over right now, for the caret and the tray's ring. */
export interface RailAim {
  /** Caret position from the top of the rail list, or null for none. */
  caretY: number | null;
  /** An empty section whose drop zone is lit. */
  dz: string | null;
  /** Released here, the dragged row would be hidden. */
  hiding: boolean;
  /** Released here, the dragged row would be hidden but cannot be (Advanced). */
  blocked: boolean;
}

export const NO_AIM: RailAim = { caretY: null, dz: null, hiding: false, blocked: false };

/** One measured thing in the rail list, in display order. */
export interface RailItem {
  kind: "row" | "head" | "dz";
  /** The section it belongs to. A heading's is the section it heads. */
  section: string;
  top: number;
  bottom: number;
}

/** A place a page or console would land. `index` counts the rows staying in
 *  that section; Infinity is the end. `caretY` is null for an empty section,
 *  whose drop zone lights up instead of a caret. */
export interface RowPlace {
  section: string;
  index: number;
  caretY: number | null;
}

/**
 * Where a dragged row lands, given the still items and the sections' display
 * order (which names sections with no heading, like the top group).
 *
 * Midpoints, as in bar-drop's gapFromMidpoints: past the middle of a row means
 * after it. Above a heading means the end of the section before it.
 */
export function rowPlace(items: readonly RailItem[], sections: readonly string[], y: number): RowPlace | null {
  if (sections.length === 0) return null;
  const counts = new Map<string, number>();
  for (const it of items) {
    if (y <= (it.top + it.bottom) / 2) {
      if (it.kind === "row") return { section: it.section, index: counts.get(it.section) ?? 0, caretY: it.top - 1 };
      if (it.kind === "dz") return { section: it.section, index: 0, caretY: null };
      const before = sections[sections.indexOf(it.section) - 1];
      // A heading with nothing above it: the top group is empty and has no
      // rows to measure, so its end is just above this heading.
      return { section: before ?? it.section, index: before ? Infinity : 0, caretY: it.top - 3 };
    }
    if (it.kind === "row") counts.set(it.section, (counts.get(it.section) ?? 0) + 1);
  }
  const last = items.at(-1);
  if (last?.kind === "dz") return { section: last.section, index: 0, caretY: null };
  return { section: sections[sections.length - 1], index: Infinity, caretY: last ? last.bottom + 1 : 0 };
}

/**
 * Where a dragged section lands: before the first heading whose middle is below
 * the pointer, or at the end. `heads` leaves the dragged section's own heading
 * out. Null `before` means last; `endY` is where the caret goes then.
 */
export function sectionPlace(
  heads: readonly RailItem[],
  y: number,
  endY: number,
): { before: string | null; caretY: number } {
  for (const h of heads) {
    if (y <= (h.top + h.bottom) / 2) return { before: h.section, caretY: h.top - 5 };
  }
  return { before: null, caretY: endY };
}
