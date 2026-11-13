// doc-helpers.ts — reading the stage plots document, shared by /stageplots and
// its editor.

import type { BackgroundView, Plot, StagePlotsView, Venue } from "@main/types/stageplots";

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

/** The plot to show: the one picked in this venue, else its default, else its first. */
export function selectedPlot(venue: Venue | null, plots: readonly Plot[], pick: { venueId: string; plotId: string } | null): Plot | null {
  if (!venue) return null;
  return (
    plots.find((p) => pick?.venueId === venue.id && p.id === pick.plotId) ?? plots.find((p) => p.id === venue.defaultPlotId) ?? plots[0] ?? null
  );
}

/** Home venues first, then offsite, each in the order they were added. */
export function venueGroups(venues: readonly Venue[]): { label: string; venues: Venue[] }[] {
  return [
    { label: "Home", venues: venues.filter((v) => v.kind === "home") },
    { label: "Offsite", venues: venues.filter((v) => v.kind === "offsite") },
  ].filter((g) => g.venues.length > 0);
}

/** A venue's plots, in its tab order. */
export function plotsOf(doc: StagePlotsView, venue: Venue): Plot[] {
  const byId = new Map(doc.plots.map((p) => [p.id, p]));
  return venue.plotIds.map((id) => byId.get(id)).filter((p): p is Plot => p !== undefined);
}

export function backgroundOf(doc: StagePlotsView, plot: Plot | null | undefined): BackgroundView | null {
  return plot?.backgroundId ? (doc.backgrounds.find((b) => b.id === plot.backgroundId) ?? null) : null;
}

/** "412 KB", "3.1 MB". */
export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
