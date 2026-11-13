// stageplots-doc.ts — pure readings of the stage plots document, shared by the
// routes and the editor so the two cannot name things differently.

import { PLOT_UNITS_WIDE, type Background, type Plot, type PlotItem, type Venue } from "../types/stageplots.js";

/** A plot's height in plot units: its background's aspect ratio over
 *  PLOT_UNITS_WIDE, or 16:9 when it has none. */
export function plotHeight(background: Pick<Background, "converted"> | null | undefined): number {
  if (!background || background.converted.width <= 0) return (PLOT_UNITS_WIDE * 9) / 16;
  return (PLOT_UNITS_WIDE * background.converted.height) / background.converted.width;
}

/**
 * A cable with its box set to its points' bounding box, and no rotation: the
 * box of a cable is always derived, by the editor and by the server alike. Not
 * rounded: its points are already inside the plot, and a box rounded up from
 * them (666.7 for a cable the full height of a plot 666.666… high) would not be.
 */
export function withCableBox(it: PlotItem): PlotItem {
  const pts = it.points ?? [];
  if (pts.length === 0) return it;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { ...it, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, rotation: 0 };
}

/**
 * An item moved up, if it must be, to fit wholly on a plot `height` units high:
 * one whose bottom passes the edge goes up until it sits on it (to the top if it
 * is taller than the plot), and a cable's points below the edge come up to it.
 * The item itself when it already fits. The one rule for a plot made shorter:
 * the server moving the saved items (itemsWithin) and the editor fitting a
 * draft and its undo steps both use it, so the two always agree.
 */
export function fitToHeight(it: PlotItem, height: number): PlotItem {
  if (it.type === "cable" && it.points) {
    if (!it.points.some((p) => p[1] > height)) return it;
    return withCableBox({ ...it, points: it.points.map(([x, y]): [number, number] => [x, Math.min(y, height)]) });
  }
  if (it.y + it.h <= height) return it;
  return { ...it, y: Math.max(0, height - it.h) };
}

/** Each plot drawn on `backgroundId`, by venue and plot name, in plot order. */
export function plotsUsing(
  doc: { venues: readonly Pick<Venue, "id" | "name">[]; plots: readonly Pick<Plot, "venueId" | "name" | "backgroundId">[] },
  backgroundId: string,
): { venue: string; plot: string }[] {
  const venueName = new Map(doc.venues.map((v) => [v.id, v.name]));
  return doc.plots.filter((p) => p.backgroundId === backgroundId).map((p) => ({ venue: venueName.get(p.venueId) ?? "?", plot: p.name }));
}
