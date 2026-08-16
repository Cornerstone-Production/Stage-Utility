// Home's grid: what is on it, how big, in what order, and when.
//
// Pure. Home has no canvas, so all of it is array work over the Home View's
// object list — testable without rendering and without a server.
//
// The View's x/y/w/h is deliberately unused. See main/services/home-view.ts for
// why Home keeps a layout it does not lay out.

import type { HomeCardSize, HomeVisibility, LayoutObject, LayoutObjectConfig } from "@main/types/views";
import { LAYOUT_OBJECTS } from "../../main/layout-objects";
import type { HomeMode } from "./home-mode";

/** Columns in the grid. Every size is a whole number of these. */
export const COLUMNS = 3;

/**
 * The four tiles, in columns × rows.
 *
 * Chosen so they tile, which is the whole reason there are four and not a
 * width field: `S + M`, `S + L` and `S + S + S` each fill a row exactly, `XL`
 * is a row of its own, and a Large leaves a 1-wide, 2-tall gap that two stacked
 * Smalls complete. Small being 1×1 is what makes every leftover slot fillable.
 *
 * What this gives up, knowingly: `M + M` is 4 over a 3-wide row, so two equal
 * halves side by side is not expressible. Thirds and 1/3 + 2/3 replace it.
 */
export const SIZES: Record<HomeCardSize, { w: number; h: number; label: string }> = {
  s: { w: 1, h: 1, label: "Small" },
  m: { w: 2, h: 1, label: "Medium" },
  l: { w: 2, h: 2, label: "Large" },
  xl: { w: 3, h: 2, label: "Extra large" },
};

export const SIZE_ORDER: HomeCardSize[] = ["s", "m", "l", "xl"];

/** What each visibility means, in the operator's words. */
export const WHEN_LABELS: Record<HomeVisibility, string> = {
  always: "Always",
  live: "During a service",
  idle: "Rest of the week",
};

/** A card's size, falling back to the registry's default for its type. */
export function sizeOf(o: LayoutObject): HomeCardSize {
  return o.home?.size ?? defaultSize(o.config.type);
}

/** A card's visibility. Cards default to always — a widget somebody placed
 *  should be on the page unless they said otherwise. */
export function whenOf(o: LayoutObject): HomeVisibility {
  return o.home?.when ?? defaultWhen(o.config.type);
}

/** The size a widget of this type arrives at. Medium unless the registry says
 *  otherwise — see `homeSize` on the spec. */
export function defaultSize(type: string): HomeCardSize {
  return LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS]?.homeSize ?? "m";
}

export function defaultWhen(type: string): HomeVisibility {
  return LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS]?.homeWhen ?? "always";
}

/** The cards on the page right now, in order. */
export function visibleCards(objects: readonly LayoutObject[], mode: HomeMode): LayoutObject[] {
  return objects.filter((o) => {
    const w = whenOf(o);
    return w === "always" || w === mode;
  });
}

// ── Operations ───────────────────────────────────────────────────────────────
// Every one returns a NEW array and never mutates its input, so a caller can
// compare by reference and a failed save can put the old list straight back.

/** Add a widget at the end, at its type's default size. */
export function addCard(
  objects: readonly LayoutObject[],
  type: string,
  id: string,
): LayoutObject[] {
  const spec = LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS];
  return [
    ...objects,
    {
      id,
      // Geometry Home never reads. Filled because the type requires it, and
      // stacked rather than piled so an output still bound to Home from before
      // the grid renders something legible instead of four cards on one spot.
      x: 0.04,
      y: Math.min(0.9, 0.04 + objects.length * 0.06),
      w: 0.92,
      h: 0.2,
      z: objects.length + 1,
      home: { size: defaultSize(type), when: defaultWhen(type) },
      config: spec.config() as LayoutObjectConfig,
      style: spec.style(),
    } as LayoutObject,
  ];
}

export function removeCard(objects: readonly LayoutObject[], id: string): LayoutObject[] {
  return objects.filter((o) => o.id !== id);
}

export function setSize(objects: readonly LayoutObject[], id: string, size: HomeCardSize): LayoutObject[] {
  return objects.map((o) => (o.id === id ? { ...o, home: { ...o.home, size } } : o));
}

export function setWhen(objects: readonly LayoutObject[], id: string, when: HomeVisibility): LayoutObject[] {
  return objects.map((o) => (o.id === id ? { ...o, home: { ...o.home, when } } : o));
}

/**
 * Move a card to another position in the list.
 *
 * Indexes are into the FULL list, not the visible one — the editor shows every
 * card including the ones whose mood is not current, so what you drag is what
 * you reorder. Out-of-range indexes return the list unchanged rather than
 * throwing: a drag that ends on nothing is a no-op, not an error.
 */
export function moveCard(objects: readonly LayoutObject[], from: number, to: number): LayoutObject[] {
  if (from < 0 || to < 0 || from >= objects.length || to >= objects.length || from === to) {
    return [...objects];
  }
  const next = [...objects];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/**
 * How full each row is, walking the cards in order.
 *
 * The editor shows this so the arithmetic is visible while you arrange: a row
 * that does not reach three columns has a gap in it. Rows are computed the way
 * the grid packs them — a card that does not fit the remaining space starts a
 * new row — with a tall card counted in every row it covers.
 */
export function rowFill(cards: readonly LayoutObject[]): number[] {
  const rows: number[] = [];
  let row = 0;
  let spare: number[] = [];
  for (const c of cards) {
    const { w, h } = SIZES[sizeOf(c)];
    while (rows.length <= row) rows.push(0);
    if (rows[row] + w > COLUMNS) {
      row = rows.length;
      rows.push(0);
    }
    for (let i = 0; i < h; i++) {
      while (rows.length <= row + i) rows.push(0);
      rows[row + i] += w;
    }
    if (h > 1) spare.push(row);
    if (rows[row] >= COLUMNS) {
      // This row is closed; continue on the first row that still has space.
      const next = rows.findIndex((n, i) => i > row && n < COLUMNS);
      row = next === -1 ? rows.length : next;
      spare = spare.filter((r) => r !== row);
    }
  }
  return rows;
}
