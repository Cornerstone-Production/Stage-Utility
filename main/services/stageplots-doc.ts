// stageplots-doc.ts — pure readings of the stage plots document, shared by the
// routes and the editor so the two cannot name things differently.

import { PLOT_UNITS_WIDE, type Background, type PendingRemoval, type Plot, type PlotItem, type PlotOverride, type StagePlotsDoc, type Venue } from "../types/stageplots.js";

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

/** Why a venue shows the plot it shows: an override for this plan, or its default. */
export type PlotReason = "plan" | "default";

/**
 * The plot `venueId` shows for `planId`: the plan's override for this venue
 * when it names one of the venue's plots, else the venue's default. Null only
 * for a venue with no plots (or none by that id). An override whose plot is
 * gone, or belongs to another venue, falls back to the default rather than
 * leaving the venue blank. With no plan (none live or next, or Planning Center
 * unreachable, which the caller turns into null) it is the default.
 */
export function resolvePlot(
  doc: { venues: readonly Venue[]; plots: readonly Plot[]; overrides: readonly PlotOverride[] },
  venueId: string,
  planId: string | null,
): { plot: Plot | null; reason: PlotReason } {
  const venue = doc.venues.find((v) => v.id === venueId);
  if (!venue) return { plot: null, reason: "default" };
  const ofVenue = (id: string | null | undefined) =>
    id ? (doc.plots.find((p) => p.id === id && p.venueId === venueId && venue.plotIds.includes(id)) ?? null) : null;
  if (planId !== null) {
    const ov = doc.overrides.find((o) => o.planId === planId && o.venueId === venueId);
    const plot = ofVenue(ov?.plotId);
    if (plot) return { plot, reason: "plan" };
  }
  return { plot: ofVenue(venue.defaultPlotId), reason: "default" };
}

/** The overrides that name `plotId`: the plans whose override its delete clears. */
export function overridesOfPlot(doc: { overrides: readonly PlotOverride[] }, plotId: string): PlotOverride[] {
  return doc.overrides.filter((o) => o.plotId === plotId);
}

/** Pending removals in their one order (origin, then secret), one per secret and page: the
 *  first of a pair kept, so the same list always comes out the same. */
export function sortPending(list: readonly PendingRemoval[]): PendingRemoval[] {
  const seen = new Set<string>();
  const out: PendingRemoval[] = [];
  for (const e of [...list].sort((a, b) => a.origin.localeCompare(b.origin) || a.secret.localeCompare(b.secret) || a.since.localeCompare(b.since))) {
    const key = `${e.origin} ${e.secret}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** How a restore stands to the server the config came from (config-snapshot.ts decides). */
export type RestoreMode =
  /** Another server's config, or one that names no server: this server keeps its own id. */
  | "keep-own"
  /** This server's own config. */
  | "same-id"
  /** Another server's config, and this box replaces that server. */
  | "replace";

/**
 * The live stage plots document a restore replaces: what it holds, undefined when there is none
 * (a fresh install), or "unknown" when it is there and cannot be read, which holds links nobody
 * can know.
 */
export type LiveStagePlots = StagePlotsDoc | undefined | "unknown";

/**
 * The stage plots document a restore writes: the restored one, merged with the live one it
 * replaces so that no secret that may be live on a page is left unknown, and none that was
 * revoked comes back. Matched by secret and page.
 *
 *   A link both files hold on a venue stays published, in every mode: it is provably this
 *   server's (a box restoring its own backup with no server id on either side says "keep own").
 *   Otherwise a restored link comes back published only when this box replaces the config's
 *   server, or restores its own config onto a fresh install (no live stage plots, or no venues):
 *   anywhere else the live file not holding it means it was revoked since. One that does not
 *   come back is queued for removal, unless it is another server's (keep-own), which stays with
 *   that server. The restored queue is kept, except another server's.
 *   Every live link, on a venue or queued, that the result does not hold is queued.
 *   A live file that cannot be read ("unknown") is never taken for a fresh install: no restored
 *   link comes back published, since it may have been revoked since, and each is queued as above.
 *
 * Pure, and handed what the files hold, so the cases can be put to it one by one.
 */
export function mergeRestoredStagePlots({
  restored,
  live,
  mode,
  now,
}: {
  restored: StagePlotsDoc;
  live: LiveStagePlots;
  mode: RestoreMode;
  now: string;
}): { doc: StagePlotsDoc; unpublished: number; queued: number } {
  const key = (secret: string, origin: string) => `${origin} ${secret}`;
  const unknown = live === "unknown";
  const known = unknown ? undefined : live;
  const liveOnVenues = new Map((known?.venues ?? []).flatMap((v) => (v.publish ? [[key(v.publish.secret, v.publish.origin), v.publish] as const] : [])));
  const liveQueued = new Map((known?.pendingRemovals ?? []).map((e) => [key(e.secret, e.origin), e] as const));
  const fresh = !unknown && (!known || known.venues.length === 0);
  const queue: PendingRemoval[] = [];
  let unpublished = 0;
  const venues: Venue[] = restored.venues.map((v) => {
    const p = v.publish;
    if (!p) return v;
    const k = key(p.secret, p.origin);
    const keep = liveOnVenues.has(k) || (!unknown && !liveQueued.has(k) && (mode === "replace" || (mode === "same-id" && fresh)));
    if (keep) return v;
    unpublished++;
    if (mode !== "keep-own") queue.push({ secret: p.secret, origin: p.origin, since: now, reason: "restored over" });
    const { publish: _publish, ...rest } = v;
    return rest;
  });
  const restoredQueue = mode === "keep-own" ? restored.pendingRemovals.filter((e) => liveQueued.has(key(e.secret, e.origin)) || liveOnVenues.has(key(e.secret, e.origin))) : restored.pendingRemovals;
  const held = new Set([...venues.flatMap((v) => (v.publish ? [key(v.publish.secret, v.publish.origin)] : [])), ...restoredQueue.map((e) => key(e.secret, e.origin)), ...queue.map((e) => key(e.secret, e.origin))]);
  for (const [k, p] of liveOnVenues) if (!held.has(k)) queue.push({ secret: p.secret, origin: p.origin, since: now, reason: "restored over" });
  for (const [k, e] of liveQueued) if (!held.has(k)) queue.push(e);
  const before = new Set(restoredQueue.map((e) => key(e.secret, e.origin)));
  const pendingRemovals = sortPending([...restoredQueue, ...queue]);
  return {
    doc: { ...restored, venues, pendingRemovals },
    unpublished,
    queued: pendingRemovals.filter((e) => !before.has(key(e.secret, e.origin))).length,
  };
}
