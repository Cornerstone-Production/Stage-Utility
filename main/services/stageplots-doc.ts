// stageplots-doc.ts — pure readings of the stage plots document, shared by the
// routes and the editor so the two cannot name things differently.

import type { Plot, Venue } from "../types/stageplots.js";

/** Each plot drawn on `backgroundId`, by venue and plot name, in plot order. */
export function plotsUsing(
  doc: { venues: readonly Pick<Venue, "id" | "name">[]; plots: readonly Pick<Plot, "venueId" | "name" | "backgroundId">[] },
  backgroundId: string,
): { venue: string; plot: string }[] {
  const venueName = new Map(doc.venues.map((v) => [v.id, v.name]));
  return doc.plots.filter((p) => p.backgroundId === backgroundId).map((p) => ({ venue: venueName.get(p.venueId) ?? "?", plot: p.name }));
}
