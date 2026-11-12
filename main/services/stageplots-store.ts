// stageplots-store.ts — venues, backgrounds and plots, in one config store
// (stageplots.json). The images a background names live in the image folders
// (stageplots-files.ts); this file holds only their hashes.
//
// The rules here are the ones the routes apply on a save, and a restore is held
// to the same ones through checkStagePlotsDoc. Every id a document names
// resolves: a plot's venue and background exist, a venue lists exactly its own
// plots, and its default is one of them.

import {
  STAGEPLOT_LIMITS,
  type Background,
  type BackgroundOriginalMime,
  type BackgroundSourceExt,
  type Plot,
  type StagePlotsDoc,
  type Venue,
  type VenueKind,
} from "../types/stageplots.js";
import { DataStore } from "./data-store.js";
import { isRecord } from "./is-record.js";
import { asArray, asObject, checked, refuse, required, textList, uniqueIds } from "./restore-check.js";

const EMPTY: StagePlotsDoc = { venues: [], backgrounds: [], plots: [] };

/** Ids the server mints and routes put in a URL: letters, digits, `-` and `_`. */
export const STAGEPLOT_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** A content name's hash: the first 16 hex of a SHA-256 (image-files.ts). */
export const STAGEPLOT_HASH = /^[0-9a-f]{16}$/;

const KINDS: readonly VenueKind[] = ["home", "offsite"];
const ORIGINAL_MIMES: readonly BackgroundOriginalMime[] = ["image/png", "image/jpeg", "application/pdf"];
const SOURCE_EXTS: readonly BackgroundSourceExt[] = ["png", "jpg"];

/** Why `v` is not a usable name for `what` ("the venue"), or null. */
export function nameProblem(v: unknown, what: string): string | null {
  if (typeof v !== "string" || v.trim() === "") return `${what} needs a name`;
  if (v.trim().length > STAGEPLOT_LIMITS.nameChars) return `${what}'s name is longer than ${STAGEPLOT_LIMITS.nameChars} characters`;
  return null;
}

function notesProblem(v: unknown, what: string): string | null {
  if (typeof v !== "string") return `${what}'s notes must be text`;
  if (v.length > STAGEPLOT_LIMITS.notesChars) return `${what}'s notes are longer than ${STAGEPLOT_LIMITS.notesChars} characters`;
  return null;
}

function fadeProblem(v: unknown, what: string): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return `${what}'s background fade must be a number from 0 to 1`;
  return null;
}

/**
 * Why a venue body cannot be saved, or null. `partial` is a PATCH: only the
 * fields present are checked, and none is required.
 */
export function validateVenueInput(body: unknown, { partial }: { partial: boolean }): string | null {
  if (!isRecord(body)) return "the venue must be an object";
  if (!partial || body.name !== undefined) {
    const p = nameProblem(body.name, "the venue");
    if (p) return p;
  }
  if ((!partial || body.kind !== undefined) && !KINDS.includes(body.kind as VenueKind)) return "the venue's kind must be home or offsite";
  if (body.notes !== undefined) {
    const p = notesProblem(body.notes, "the venue");
    if (p) return p;
  }
  return null;
}

/** Why a plot body cannot be saved, or null. A background id is checked
 *  against the document by the route; here only its type. */
export function validatePlotInput(body: unknown, { partial }: { partial: boolean }): string | null {
  if (!isRecord(body)) return "the plot must be an object";
  if (!partial || body.name !== undefined) {
    const p = nameProblem(body.name, "the plot");
    if (p) return p;
  }
  if (body.bgFade !== undefined) {
    const p = fadeProblem(body.bgFade, "the plot");
    if (p) return p;
  }
  if (body.backgroundId !== undefined && body.backgroundId !== null && typeof body.backgroundId !== "string") {
    return "the plot's background must be a background id or null";
  }
  return null;
}

/** Why one more of `kind` cannot be added to `doc`, or null. */
/** What each limit says when it is reached, for a save and a restore alike. */
const LIMIT_SAYS = {
  venue: `there can be at most ${STAGEPLOT_LIMITS.venues} venues`,
  background: `there can be at most ${STAGEPLOT_LIMITS.backgrounds} backgrounds`,
  plot: `a venue can have at most ${STAGEPLOT_LIMITS.plotsPerVenue} plots`,
} as const;

export function limitProblem(doc: StagePlotsDoc, kind: "venue" | "plot" | "background", venueId?: string): string | null {
  const count =
    kind === "venue" ? doc.venues.length : kind === "background" ? doc.backgrounds.length : doc.plots.filter((p) => p.venueId === venueId).length;
  const max = kind === "venue" ? STAGEPLOT_LIMITS.venues : kind === "background" ? STAGEPLOT_LIMITS.backgrounds : STAGEPLOT_LIMITS.plotsPerVenue;
  return count >= max ? LIMIT_SAYS[kind] : null;
}

function orRefuse(problem: string | null): void {
  if (problem) refuse(problem);
}

function checkId(v: unknown, what: string): string {
  if (typeof v !== "string" || !STAGEPLOT_ID.test(v)) refuse(`${what}'s id must be 1 to 80 letters, digits, - or _`);
  return v;
}

function checkHash(v: unknown, what: string): string {
  if (typeof v !== "string" || !STAGEPLOT_HASH.test(v)) refuse(`${what}'s hash must be 16 lower-case hex characters`);
  return v;
}

function checkCount(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) refuse(`${what} must be a whole number`);
  return v;
}

function pageOrNull(v: unknown, what: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) refuse(`${what} must be a page number or null`);
  return v;
}

function checkVenue(raw: unknown, i: number): Venue {
  const v = asObject(raw, `venue ${i + 1}`);
  const id = checkId(v.id, `venue ${i + 1}`);
  const what = `venue "${id}"`;
  orRefuse(nameProblem(v.name, what));
  if (!KINDS.includes(v.kind as VenueKind)) refuse(`${what}'s kind must be home or offsite`);
  orRefuse(notesProblem(v.notes, what));
  const plotIds = textList(v.plotIds, `${what}'s plots`);
  if (v.defaultPlotId !== null && typeof v.defaultPlotId !== "string") refuse(`${what}'s default plot must be a plot id or null`);
  return {
    id,
    name: v.name as string,
    kind: v.kind as VenueKind,
    notes: v.notes as string,
    plotIds,
    defaultPlotId: v.defaultPlotId as string | null,
  };
}

function checkBackground(raw: unknown, i: number): Background {
  const b = asObject(raw, `background ${i + 1}`);
  const id = checkId(b.id, `background ${i + 1}`);
  const what = `background "${id}"`;
  orRefuse(nameProblem(b.name, what));
  const original = asObject(b.original, `${what}'s original`);
  if (!ORIGINAL_MIMES.includes(original.mime as BackgroundOriginalMime)) refuse(`${what}'s original must be a PNG, JPEG or PDF`);
  const source = asObject(b.source, `${what}'s source`);
  if (!SOURCE_EXTS.includes(source.ext as BackgroundSourceExt)) refuse(`${what}'s source must be a png or jpg`);
  const converted = asObject(b.converted, `${what}'s converted image`);
  required(b.cleanup, "boolean", `${what}'s clean-up`);
  return {
    id,
    name: b.name as string,
    original: {
      hash: checkHash(original.hash, `${what}'s original`),
      mime: original.mime as BackgroundOriginalMime,
      bytes: checkCount(original.bytes, `${what}'s original size`),
    },
    source: { hash: checkHash(source.hash, `${what}'s source`), ext: source.ext as BackgroundSourceExt },
    converted: {
      hash: checkHash(converted.hash, `${what}'s converted image`),
      width: checkCount(converted.width, `${what}'s width`),
      height: checkCount(converted.height, `${what}'s height`),
      bytes: checkCount(converted.bytes, `${what}'s converted size`),
    },
    cleanup: b.cleanup as boolean,
    pdfPage: pageOrNull(b.pdfPage, `${what}'s PDF page`),
    pdfPages: pageOrNull(b.pdfPages, `${what}'s PDF page count`),
  };
}

function checkPlot(raw: unknown, i: number): Plot {
  const p = asObject(raw, `plot ${i + 1}`);
  const id = checkId(p.id, `plot ${i + 1}`);
  const what = `plot "${id}"`;
  required(p.venueId, "string", `${what}'s venue`);
  orRefuse(nameProblem(p.name, what));
  if (p.backgroundId !== null && typeof p.backgroundId !== "string") refuse(`${what}'s background must be a background id or null`);
  orRefuse(fadeProblem(p.bgFade, what));
  const items = asArray(p.items, `${what}'s items`).map((item, j) => asObject(item, `${what}'s item ${j + 1}`));
  return {
    id,
    venueId: p.venueId as string,
    name: p.name as string,
    backgroundId: p.backgroundId as string | null,
    bgFade: p.bgFade as number,
    items,
    version: checkCount(p.version, `${what}'s version`),
  };
}

/**
 * A whole document, every field shaped as a save would leave it and every id
 * it names resolved — or a throw naming the first that is not. The restore
 * check, and the rule the routes' writes keep.
 */
export function checkStagePlotsDoc(raw: unknown): StagePlotsDoc {
  const d = asObject(raw, "the stage plots");
  const venues = asArray(d.venues, "the venues").map(checkVenue);
  const backgrounds = asArray(d.backgrounds, "the backgrounds").map(checkBackground);
  const plots = asArray(d.plots, "the plots").map(checkPlot);
  for (const [what, list] of [["the venues", venues], ["the backgrounds", backgrounds], ["the plots", plots]] as const) {
    uniqueIds(list.map((e) => ({ id: e.id })), what);
  }
  if (venues.length > STAGEPLOT_LIMITS.venues) refuse(LIMIT_SAYS.venue);
  if (backgrounds.length > STAGEPLOT_LIMITS.backgrounds) refuse(LIMIT_SAYS.background);

  const venueById = new Map(venues.map((v) => [v.id, v]));
  const backgroundIds = new Set(backgrounds.map((b) => b.id));
  const plotById = new Map(plots.map((p) => [p.id, p]));
  for (const p of plots) {
    const venue = venueById.get(p.venueId);
    if (!venue) refuse(`plot "${p.id}" names a venue that does not exist`);
    if (!venue.plotIds.includes(p.id)) refuse(`plot "${p.id}" is not listed by its venue "${venue.id}"`);
    if (p.backgroundId !== null && !backgroundIds.has(p.backgroundId)) refuse(`plot "${p.id}" names a background that does not exist`);
  }
  for (const v of venues) {
    if (new Set(v.plotIds).size !== v.plotIds.length) refuse(`venue "${v.id}" lists a plot more than once`);
    if (v.plotIds.length > STAGEPLOT_LIMITS.plotsPerVenue) refuse(LIMIT_SAYS.plot);
    for (const plotId of v.plotIds) {
      if (plotById.get(plotId)?.venueId !== v.id) refuse(`venue "${v.id}" lists plot "${plotId}", which is not one of its plots`);
    }
    if (v.plotIds.length > 0 ? v.defaultPlotId === null || !v.plotIds.includes(v.defaultPlotId) : v.defaultPlotId !== null) {
      refuse(`venue "${v.id}"'s default plot must be one of its plots`);
    }
  }
  return { venues, backgrounds, plots };
}

const store = new DataStore<StagePlotsDoc>("stageplots.json", EMPTY, "config", {
  restoreCheck: checked(checkStagePlotsDoc),
});

export const stageplotsStore = {
  /** The document. Throws a StoreReadError (503) when the file cannot be read,
   *  rather than answering with no venues. */
  get(): Promise<StagePlotsDoc> {
    return store.loadStrict();
  },
  /**
   * Read-modify-write, serialized against every other write. The result is
   * held to checkStagePlotsDoc before it is saved, so no route can leave a
   * dangling id; a mutator that returns its input writes nothing.
   */
  update(fn: (doc: StagePlotsDoc) => StagePlotsDoc): Promise<StagePlotsDoc> {
    return store.update((doc) => {
      const next = fn(doc);
      return next === doc ? doc : checkStagePlotsDoc(next);
    });
  },
};
