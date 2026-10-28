// Where each Home widget sits, as grid cells.
//
// Home used to be a packed flow: cards in list order, each falling into the
// first slot it fitted. That makes a tidy page and gives the operator no way to
// say "leave a gap here" — every hole closed itself, so a dashboard could not be
// grouped, only ordered.
//
// A card may now carry an explicit `col`/`row`. The rules, in order:
//
//   - A card with coordinates sits exactly there.
//   - A card without them flows into the first gap that fits, as before, so
//     nothing already on disk moves and a newly added widget still lands
//     somewhere sensible without being placed by hand.
//   - Dropping a card onto occupied cells pushes what was there DOWNWARD, and
//     whatever that lands on in turn, so a drop always has somewhere to go and
//     never silently covers a widget.
//
// Nothing here re-packs afterwards. That is the whole point: a gap the operator
// left is a gap, not a hole waiting to be filled.
//
// Pure and coordinate-only — no DOM, no React — because this is the part that
// has to be right, and a grid engine that can only be checked by dragging
// things around a screen is a grid engine nobody can check.

import type { HomeCardSize, LayoutObject } from "@main/types/views";
import { COLUMNS, SIZES, sizeOf } from "./home-cards";

/** One card's footprint. `col`/`row` are 1-based, like CSS grid lines. */
export interface Box {
  id: string;
  col: number;
  row: number;
  w: number;
  h: number;
}

/** A card's stored column, or null when it has never been placed by hand. */
export function colOf(o: LayoutObject): number | null {
  const c = o.home?.col;
  return typeof c === "number" && c >= 1 ? Math.floor(c) : null;
}

export function rowOf(o: LayoutObject): number | null {
  const r = o.home?.row;
  return typeof r === "number" && r >= 1 ? Math.floor(r) : null;
}

/** Is this card placed by hand, rather than flowing? */
export function isPlaced(o: LayoutObject): boolean {
  return colOf(o) !== null && rowOf(o) !== null;
}

/** Keep a box inside the grid: a 2-wide card cannot start in the last column. */
export function clampCol(col: number, w: number): number {
  return Math.max(1, Math.min(col, COLUMNS - w + 1));
}

export function overlaps(a: Box, b: Box): boolean {
  return (
    a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h
  );
}

/**
 * Every card's footprint, explicit placements honoured and the rest flowed.
 *
 * The flow is first-fit scanning rows top to bottom, which is what the CSS grid
 * did on its own before any of this existed — so a layout nobody has dragged
 * lays out exactly as it always has.
 */
export function boxesOf(cards: readonly LayoutObject[]): Box[] {
  // Explicit ones first: they own their cells, and the flowing cards have to
  // route around them rather than the other way about.
  const explicit: Box[] = [];
  for (const o of cards) {
    if (!isPlaced(o)) continue;
    const { w, h } = SIZES[sizeOf(o)];
    explicit.push({ id: o.id, col: clampCol(colOf(o)!, w), row: rowOf(o)!, w, h });
  }
  // Two stored placements can overlap: a card grown to XL or Tall where it
  // stands covers whatever was beside or below it, and a layout saved before
  // resizing pushed anything still holds that. Honoured as stored, the grown
  // card drew straight over its neighbours. Settled top to bottom instead, so
  // the later of two overlapping cards moves down, as a drop would push it.
  const placed = settle(explicit);
  for (const o of cards) {
    if (isPlaced(o)) continue;
    const { w, h } = SIZES[sizeOf(o)];
    placed.push(firstFit(placed, o.id, w, h));
  }
  // Back into the caller's order, so a consumer can zip this against its list.
  const byId = new Map(placed.map((b) => [b.id, b]));
  return cards.map((o) => byId.get(o.id)!).filter(Boolean);
}

/** The first cell, scanning rows then columns, where a w×h box fits. */
function firstFit(taken: readonly Box[], id: string, w: number, h: number): Box {
  for (let row = 1; row < 500; row++) {
    for (let col = 1; col <= COLUMNS - w + 1; col++) {
      const candidate: Box = { id, col, row, w, h };
      if (!taken.some((b) => overlaps(b, candidate))) return candidate;
    }
  }
  // Unreachable for any real page; a box rather than a throw, because a Home
  // that cannot place a widget should still draw the other eleven.
  return { id, col: 1, row: 500, w, h };
}

/**
 * Move one box, pushing whatever it lands on downward.
 *
 * The cascade is the reason this is not a swap: a swap needs two cards of the
 * same shape, and these are five shapes. Pushing down always has room, and the
 * order it settles into is the order you saw while dragging.
 */
export function pushAway(boxes: readonly Box[], moved: Box): Box[] {
  const rest = boxes.filter((b) => b.id !== moved.id);
  return settle(rest, [moved]);
}

/**
 * `boxes` laid down nearest-first on top of `fixed`, each slid straight down
 * until it sits on nothing already laid. Nearest-first so a card just below
 * moves before one further down and the cascade cannot leapfrog.
 */
function settle(boxes: readonly Box[], fixed: readonly Box[] = []): Box[] {
  const settled: Box[] = [...fixed];
  const order = [...boxes].sort((a, b) => a.row - b.row || a.col - b.col);
  for (const box of order) {
    let candidate = { ...box };
    // Bounded by the number of cards: each pass moves this box strictly
    // downward past one more of them, so it cannot loop.
    for (let guard = 0; guard <= settled.length; guard++) {
      const hit = settled.find((s) => overlaps(s, candidate));
      if (!hit) break;
      candidate = { ...candidate, row: hit.row + hit.h };
    }
    settled.push(candidate);
  }
  return settled;
}

/** The placement patch for a drop: every card gets coordinates, and the moved
 *  one gets the cell it was dropped on. */
export function placeAt(
  cards: readonly LayoutObject[],
  id: string,
  col: number,
  row: number,
): LayoutObject[] {
  const boxes = boxesOf(cards);
  const moving = boxes.find((b) => b.id === id);
  if (!moving) return cards as LayoutObject[];
  const target: Box = { ...moving, col: clampCol(col, moving.w), row: Math.max(1, row) };
  const next = pushAway(boxes, target);
  const byId = new Map(next.map((b) => [b.id, b]));
  // EVERY card is written, not just the one dragged. Freezing what was on
  // screen is what makes the drop predictable: with the others left flowing,
  // one of them could rise past the gap just made and the page would rearrange
  // itself around a move the operator thought was local.
  return cards.map((o) => {
    const b = byId.get(o.id);
    return b ? { ...o, home: { ...o.home, col: b.col, row: b.row } } : o;
  });
}

/**
 * A card at a new size, holding its place.
 *
 * A card placed by hand keeps its cell and pushes whatever it grew onto
 * downward, exactly as dropping it there would. Setting the size alone left
 * both stored where they were, and a card grown to XL or Tall covered its
 * neighbours. A flowing card needs nothing: the flow routes around it.
 */
export function resizeCard(cards: readonly LayoutObject[], id: string, size: HomeCardSize): LayoutObject[] {
  const next = cards.map((o) => (o.id === id ? { ...o, home: { ...o.home, size } } : o));
  const card = next.find((o) => o.id === id);
  if (!card || !isPlaced(card)) return next;
  return placeAt(next, id, colOf(card)!, rowOf(card)!);
}

/** Clear every hand placement, so the page packs itself again. */
export function resetPlacement(cards: readonly LayoutObject[]): LayoutObject[] {
  return cards.map((o) => {
    if (!o.home) return o;
    const { col: _col, row: _row, ...rest } = o.home;
    return { ...o, home: rest };
  });
}

/** How many rows the page needs, so the drop area covers the empty space below
 *  the last card — you cannot drop into a gap the grid does not draw. */
export function rowsNeeded(boxes: readonly Box[], extra = 2): number {
  return boxes.reduce((max, b) => Math.max(max, b.row + b.h - 1), 0) + extra;
}

/**
 * Where a newly added widget goes.
 *
 * On a page nobody has arranged, nowhere — it flows, as it always did. On a page
 * that HAS been arranged, below everything, because the first free cell is
 * frequently a gap somebody left on purpose and filling it is the one thing this
 * feature exists to stop.
 */
export function placeNewCard(cards: readonly LayoutObject[], id: string): LayoutObject[] {
  const arranged = cards.some((o) => o.id !== id && isPlaced(o));
  if (!arranged) return cards as LayoutObject[];
  const others = cards.filter((o) => o.id !== id);
  const row = rowsNeeded(boxesOf(others), 1);
  return cards.map((o) => (o.id === id ? { ...o, home: { ...o.home, col: 1, row } } : o));
}
