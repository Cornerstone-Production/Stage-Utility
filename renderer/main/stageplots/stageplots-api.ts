// stageplots-api.ts — the /api/stageplots calls, typed, in one place.
//
// Every structural change saves at once and the server broadcasts the whole
// document on stageplots:updated, so callers do not patch local state from
// these answers: useStagePlots refetches on the broadcast.

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

export const stageplotsApi = {
  get: () => invoke<StagePlotsView>("stageplots:get"),
  createVenue: (venue: VenueInput) => invoke<Venue>("stageplots:createVenue", { venue }),
  updateVenue: (id: string, changes: Partial<VenueInput>) => invoke<Venue>("stageplots:updateVenue", { id, changes }),
  deleteVenue: (id: string) => invoke<{ ok: true }>("stageplots:deleteVenue", { id }),
  setDefault: (venueId: string, plotId: string) => invoke<Venue>("stageplots:setDefault", { venueId, plotId }),
  uploadImage: (name: string, bytes: Blob, from?: PdfPage) =>
    invoke<BackgroundView>("stageplots:uploadImage", { name, bytes, ...(from ?? {}) }),
  uploadPdf: (name: string, bytes: Blob) => invoke<{ originalHash: string; bytes: number }>("stageplots:uploadPdf", { name, bytes }),
  updateBackground: (id: string, changes: { name?: string; cleanup?: boolean }) =>
    invoke<BackgroundView>("stageplots:updateBackground", { id, changes }),
  deleteBackground: (id: string) => invoke<{ ok: true }>("stageplots:deleteBackground", { id }),
  createPlot: (plot: { venueId: string; name: string; backgroundId?: string | null }) => invoke<Plot>("stageplots:createPlot", { plot }),
  duplicatePlot: (id: string) => invoke<Plot>("stageplots:duplicatePlot", { id }),
  updatePlot: (id: string, changes: PlotChanges) => invoke<Plot>("stageplots:updatePlot", { id, changes }),
  deletePlot: (id: string) => invoke<{ ok: true }>("stageplots:deletePlot", { id }),
  /** Save a plot's markup. Rejects with `status` 409 when the plot changed since `version`. */
  saveItems: (id: string, version: number, items: PlotItem[]) => invoke<{ plot: Plot }>("stageplots:saveItems", { id, version, items }),
};
