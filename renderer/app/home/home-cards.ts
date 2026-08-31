// Home's grid: what is on it, how big, in what order, and when.
//
// Pure. Home has no canvas, so all of it is array work over the Home View's
// object list — testable without rendering and without a server.
//
// The View's x/y/w/h is deliberately unused. See main/services/home-view.ts for
// why Home keeps a layout it does not lay out.

import type { HomeCardSize, HomeVisibility, LayoutObject, LayoutObjectConfig } from "@main/types/views";
import { LAYOUT_OBJECTS } from "../../main/layout-objects";
import type { HomeMode, HomeModeOrUnknown } from "./home-mode";

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
  // Full width, four rows. For content that is genuinely long — a rundown, a
  // mic-slots grid, a transcript — where showing less is not an option because
  // the list IS the widget. Height costs nothing in the tiling: only widths pack
  // into rows, so a taller tile cannot strand a gap the others could not.
  tall: { w: 3, h: 4, label: "Tall" },
};

export const SIZE_ORDER: HomeCardSize[] = ["s", "m", "l", "xl", "tall"];

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

/**
 * What Home draws when it is NOT being edited, or null for HOLD THE GRID.
 *
 * The null is load-bearing rather than a tidy default, and it is named here
 * rather than buried in a third arm of a ternary on the call site. `pco:live`
 * hydrates separately from the stage state the page's spinner waits on, so
 * answering "idle" while the live channel has not spoken made the first paint of
 * every visit draw the whole rest-of-the-week set mid-service and then take it
 * away a frame later. There is nothing true to draw yet, so nothing is drawn;
 * measured at 8-20ms, and bounded by the read's own timeout even if the server
 * never answers.
 */
export function cardsForNow(
  objects: readonly LayoutObject[],
  mode: HomeModeOrUnknown,
): LayoutObject[] | null {
  return mode === "unknown" ? null : visibleCards(objects, mode);
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

/** Replace one card, by id. For an edit that touches the object's own config
 *  rather than its placement — see card-toggles. */
export function replaceCard(objects: readonly LayoutObject[], next: LayoutObject): LayoutObject[] {
  return objects.map((o) => (o.id === next.id ? next : o));
}

export function setSize(objects: readonly LayoutObject[], id: string, size: HomeCardSize): LayoutObject[] {
  return objects.map((o) => (o.id === id ? { ...o, home: { ...o.home, size } } : o));
}

export function setWhen(objects: readonly LayoutObject[], id: string, when: HomeVisibility): LayoutObject[] {
  return objects.map((o) => (o.id === id ? { ...o, home: { ...o.home, when } } : o));
}


