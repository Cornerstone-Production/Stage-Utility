// stageplots-api.ts — the /api/stageplots calls, typed, in one place.
//
// Every structural change saves at once and the server broadcasts the whole
// document on stageplots:updated, so callers do not patch local state from
// these answers: useStagePlots refetches on the broadcast.

import type { PatchFile } from "@main/types/patch";
import type { BackgroundView, Plot, PlotItem, StagePlotsView, Venue, VenueKind } from "@main/types/stageplots";

import { invoke } from "../../lib/api";

export interface VenueInput {
  name: string;
  kind: VenueKind;
  notes?: string;
}

export interface PlotChanges {
  name?: string;
  backgroundId?: string | null;
  bgFade?: number;
}

/** The page of a PDF a raster was rendered from, as stageplots:uploadPdf kept it. */
export interface PdfPage {
  original: string;
  page: number;
  pages: number;
}

/** A publish action's answer: the venue as it now is, and anything the operator should know beside it. */
export type PublishAnswer = Venue & { notice?: string };

export const stageplotsApi = {
  get: () => invoke<StagePlotsView>("stageplots:get"),
  /** The patch, for linked connection points. Rejects (503) when it cannot be read, rather than answering the seed sheets. */
  patch: () => invoke<PatchFile>("stageplots:patch"),
  createVenue: (venue: VenueInput) => invoke<Venue>("stageplots:createVenue", { venue }),
  updateVenue: (id: string, changes: Partial<VenueInput>) => invoke<Venue>("stageplots:updateVenue", { id, changes }),
  /** `notice`: the venue was published and its link could not be removed yet (it is queued). */
  deleteVenue: (id: string) => invoke<{ ok: true; notice?: string }>("stageplots:deleteVenue", { id }),
  setDefault: (venueId: string, plotId: string) => invoke<Venue>("stageplots:setDefault", { venueId, plotId }),
  /** Give one plan its own plot for this venue, or hand it back to the default
   *  (`plotId` null). `planDate` is the plan's sort date, kept to name it by. */
  setOverride: (planId: string, venueId: string, plotId: string | null, planDate: string | null) =>
    invoke<StagePlotsView>("stageplots:setOverride", { planId, venueId, plotId, planDate }),
  uploadImage: (name: string, bytes: Blob, from?: PdfPage) =>
    invoke<BackgroundView>("stageplots:uploadImage", { name, bytes, ...(from ?? {}) }),
  uploadPdf: (name: string, bytes: Blob) => invoke<{ originalHash: string; bytes: number }>("stageplots:uploadPdf", { name, bytes }),
  updateBackground: (id: string, changes: { name?: string; cleanup?: boolean }) =>
    invoke<BackgroundView>("stageplots:updateBackground", { id, changes }),
  deleteBackground: (id: string) => invoke<{ ok: true }>("stageplots:deleteBackground", { id }),
  createPlot: (plot: { venueId: string; name: string; backgroundId?: string | null }) => invoke<Plot>("stageplots:createPlot", { plot }),
  duplicatePlot: (id: string) => invoke<Plot>("stageplots:duplicatePlot", { id }),
  updatePlot: (id: string, changes: PlotChanges) => invoke<Plot>("stageplots:updatePlot", { id, changes }),
  /** `clearedPlans`: the plans whose override named the plot, cleared with it. */
  deletePlot: (id: string) => invoke<{ ok: true; clearedPlans: string[] }>("stageplots:deletePlot", { id }),
  /** Save a plot's markup. Rejects with `status` 409 when the plot changed since `version`. */
  saveItems: (id: string, version: number, items: PlotItem[]) => invoke<{ plot: Plot }>("stageplots:saveItems", { id, version, items }),
  /** Put a venue on the public page behind a new secret link. */
  publish: (id: string) => invoke<PublishAnswer>("stageplots:publish", { id }),
  /** Move a published venue to a new link; the old one stops working once the new one is up. */
  regenerate: (id: string) => invoke<PublishAnswer>("stageplots:regenerate", { id }),
  /** Take a venue off the public page; its link stops working. */
  unpublish: (id: string) => invoke<PublishAnswer>("stageplots:unpublish", { id }),
  /** Send a published venue again, the backgrounds not yet published included. */
  publishNow: (id: string) => invoke<PublishAnswer>("stageplots:publishNow", { id }),
  /** Remove now: drop every old link queued against the page set up. */
  removePending: () => invoke<{ removed: number; left: number; waiting: number }>("stageplots:removePending"),
};
