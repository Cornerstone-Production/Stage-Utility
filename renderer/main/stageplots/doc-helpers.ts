// doc-helpers.ts — reading the stage plots document, shared by /stageplots and
// its editor.

import type { BackgroundView, Plot, StagePlotsView, VenueView } from "@main/types/stageplots";

import { cn } from "../../lib/cn";

export { plotsUsing } from "@main/services/stageplots-doc";

/** The small uppercase label over a group: Home, Offsite. */
export const eyebrow = "block text-[10px] leading-3 font-medium tracking-[0.06em] uppercase text-fg-subtle";

/** A plot tab, on /stageplots and in the editor. */
export function tabClass(selected: boolean): string {
  return cn(
    "-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-footnote font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
    selected ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg",
  );
}

/**
 * The plot to show: the one picked in this venue, else `preferId` (on
 * /stageplots, the plot the followed plan resolves to), else its default,
 * else its first.
 */
export function selectedPlot(
  venue: VenueView | null,
  plots: readonly Plot[],
  pick: { venueId: string; plotId: string } | null,
  preferId: string | null = null,
): Plot | null {
  if (!venue) return null;
  return (
    plots.find((p) => pick?.venueId === venue.id && p.id === pick.plotId) ??
    plots.find((p) => p.id === preferId) ??
    plots.find((p) => p.id === venue.defaultPlotId) ??
    plots[0] ??
    null
  );
}

/** Home venues first, then offsite, each in the order they were added. */
export function venueGroups(venues: readonly VenueView[]): { label: string; venues: VenueView[] }[] {
  return [
    { label: "Home", venues: venues.filter((v) => v.kind === "home") },
    { label: "Offsite", venues: venues.filter((v) => v.kind === "offsite") },
  ].filter((g) => g.venues.length > 0);
}

/** A venue's plots, in its tab order. */
export function plotsOf(doc: StagePlotsView, venue: VenueView): Plot[] {
  const byId = new Map(doc.plots.map((p) => [p.id, p]));
  return venue.plotIds.map((id) => byId.get(id)).filter((p): p is Plot => p !== undefined);
}

export function backgroundOf(doc: StagePlotsView, plot: Plot | null | undefined): BackgroundView | null {
  return plot?.backgroundId ? (doc.backgrounds.find((b) => b.id === plot.backgroundId) ?? null) : null;
}

/** The segment a venue's own address ends in: its address by name, or its id until it has one. */
export function venueSegment(venue: VenueView): string {
  return venue.slug ?? venue.id;
}

/** The read-only stage plots page with no app around it: the link handed to a crew, and a venue's QR code. */
export const STAGEPLOTS_SHARED_PATH = "/stageplots";
/** The same page inside the app, where the rail leads: with Edit, and the app's rail and bar around it. */
export const STAGEPLOTS_MANAGE_PATH = "/stageplots/manage";

/** A venue's own address: under /stageplots (the crew's, chromeless) unless `base` is the app's /stageplots/manage. */
export function venuePath(venue: VenueView, base: string = STAGEPLOTS_SHARED_PATH): string {
  return `${base}/${encodeURIComponent(venueSegment(venue))}`;
}

/** The venue `/stageplots/<segment>` opens: the one whose id, address or old address it is. */
export function venueAt(venues: readonly VenueView[], segment: string): VenueView | null {
  return venues.find((v) => v.id === segment) ?? venues.find((v) => v.slug === segment || v.oldSlugs.includes(segment)) ?? null;
}

export { formatBytes } from "@main/services/bytes-format";

/** The editor's address parameter: `/stageplots/edit?venue=<id>` opens the editor on that venue. (/stageplots has its own path, /stageplots/<id>.) */
export const VENUE_PARAM = "venue";
/** The editor opens on this plot of that venue, when it is one. */
export const PLOT_PARAM = "plot";
