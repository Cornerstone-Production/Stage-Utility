// stageplots-routes.ts — venues, stage-plot backgrounds and plots.
//
// Every route must finish responding before it returns (see RouteCtx).
//
//   GET    /api/stageplots                          the whole document, backgrounds with URLs; never a
//                                                   secret (the crew's /stageplots reads it too)
//   GET    /api/stageplots/venues/:id/link          { url }: the venue's public link, null while it is
//                                                   not published; the only answer with a secret
//   GET    /api/stageplots/patch                    the patch file, for linked connection points;
//                                                   503 when it cannot be read, never the seed sheets
//   POST   /api/stageplots/venues                   { name, kind, notes? } → 201 venue, its address
//                                                   made from its name (-2, -3… when taken)
//   PATCH  /api/stageplots/venues/:id               { name?, kind?, notes?, plotIds?, slug?, oldSlugs? };
//                                                   plotIds names each of its plots once, in tab
//                                                   order; a new slug keeps the old one as an
//                                                   alias, and oldSlugs may only drop aliases
//   DELETE /api/stageplots/venues/:id               the venue, its plots and its overrides; a published
//                                                   one is unpublished first → { ok, notice? };
//                                                   503 while a config restore is landing
//   POST   /api/stageplots/venues/:id/default       { plotId }
//   POST   /api/stageplots/backgrounds?name=        raw PNG or JPEG (12 MB) → 201 background
//   POST   /api/stageplots/backgrounds/pdf?name=    raw PDF (25 MB) → 201 { originalHash, bytes };
//                                                   409 while 5 PDFs wait for their page
//   POST   /api/stageplots/backgrounds?name=&original=&page=&pages=
//                                                   raw PNG of that PDF's page → 201 background
//   PATCH  /api/stageplots/backgrounds/:id          { name?, cleanup? }; clean-up re-converts
//   DELETE /api/stageplots/backgrounds/:id          409 { error, plots } while a plot uses it
//   POST   /api/stageplots/plots                    { venueId, name, backgroundId? } → 201 plot
//   POST   /api/stageplots/plots/:id/duplicate      → 201 the copy, "<name> copy"
//   PATCH  /api/stageplots/plots/:id                { name?, backgroundId?, bgFade? }
//   DELETE /api/stageplots/plots/:id                → { ok, clearedPlans, defaultPlotId }: the
//                                                   plans whose override named it, which go
//                                                   with it, and the venue's default after
//                                                   (the first plot left when it was the default)
//   PUT    /api/stageplots/plots/:id/items          { version, items } → { plot }, version + 1;
//                                                   409 { error, version } when the plot
//                                                   changed since that version
//   GET    /api/stageplots/drafts                   { drafts: [{ plotId, baseVersion, items, savedAt }] }:
//                                                   the editor's kept drafts, one per plot; a draft
//                                                   whose plot is gone is left out, and said, and
//                                                   never deleted here (a damaged stageplots.json
//                                                   reads as no plots at all)
//   PUT    /api/stageplots/plots/:id/draft          { baseVersion, items } → { plotId, baseVersion, savedAt };
//                                                   items held to a save's rules; 404 unknown plot
//   DELETE /api/stageplots/plots/:id/draft          → { ok }; nothing there is not an error
//                                                   A draft never touches stageplots.json, never
//                                                   broadcasts stageplots:updated and is never
//                                                   published: it broadcasts { drafts: [{ plotId,
//                                                   savedAt }] } on stageplots:drafts. A saved item
//                                                   list deletes its plot's draft, and deleting a plot
//                                                   or venue deletes the drafts of the plots it
//                                                   removed. A drafts write that fails after one of
//                                                   those, or a rename's carry, never turns it into a
//                                                   failure: the answer carries `draftNotice`.
//   PUT    /api/stageplots/overrides               { planId, venueId, plotId | null, planDate? }
//                                                   → the document; null removes the
//                                                   plan's override for that venue
//   POST   /api/stageplots/venues/:id/publish       → the venue, published behind a new secret link
//   POST   /api/stageplots/venues/:id/regenerate    → the venue under a new link; the old one is queued
//                                                   for removal and removed when the page takes it
//   POST   /api/stageplots/venues/:id/unpublish     → the venue, its link deleted from the page; with no
//                                                   page to ask, queued, and the answer adds notice
//   POST   /api/stageplots/venues/:id/publish-now   → the venue, everything sent again
//   POST   /api/stageplots/venues/:id/listed        { listed } → the venue, shown on (or taken off) its
//                                                   page's landing page, once the page has the list;
//                                                   409 when it is not published, notice beside it
//                                                   when the page could not take the list
//   POST   /api/stageplots/pending/remove           → { removed, left, waiting }: Remove now
//                                                   Each venue action: 404 for an unknown venue, 409
//                                                   when it is (not) published, no page is set up
//                                                   (publish, regenerate, publish-now) or the queue is
//                                                   full, 502 { error } when the page refused or did
//                                                   not answer, 400 for a plot too large to publish.
//                                                   Each of the five: 503 while a config restore is
//                                                   landing (said on [stageplots] here); Remove now
//                                                   also when the queue cannot be read, and an action
//                                                   whose new link could not be saved, and was taken
//                                                   back (stageplots-publish.ts)
//
// Every change saves at once and broadcasts the whole document on
// stageplots:updated, so a second browser follows without a reload. A change
// that changes nothing (an empty PATCH, an unchanged item list) writes and
// broadcasts nothing. Every refused upload and item save is said on
// [stageplots], with why. A body
// that breaks a rule is a 400 that says which; an id that names nothing is a
// 404. The store holds every write to checkStagePlotsDoc, so no route can
// leave a plot pointing at a venue or background that is gone.

import { randomBytes } from "node:crypto";
import type http from "node:http";

import {
  STAGEPLOT_DRAFTS_CHANNEL,
  STAGEPLOT_LIMITS,
  type Background,
  type Plot,
  type PlotDraft,
  type PlotDraftNotes,
  type StagePlotsDoc,
  type Venue,
  type VenueKind,
  type VenueLink,
} from "../../types/stageplots.js";
import { STAGEPLOTS_PATH } from "../../types/servicecue-publish.js";
import { broadcast, channelHasSubscribers } from "../broadcaster.js";
import { plotDraftsStore } from "../stageplot-drafts-store.js";
import { patchStore } from "../patch-store.js";
import { errorMessage } from "../errors.js";
import { contentName } from "../image-files.js";
import { scrub } from "../scrub.js";
import { CONVERTED_MAX_BYTES, convertBackground, prepareBackground, sniffUpload } from "../stageplots-convert.js";
import { overridesOfPlot, plotHeight, plotsUsing } from "../stageplots-doc.js";
import {
  MAX_PENDING_ORIGINALS,
  pendingOriginals,
  readStagePlotSource,
  stagePlotOriginalBytes,
  backgroundView,
  venueView,
  storeStagePlotImage,
  storeStagePlotOriginal,
  tidyStagePlotFiles,
} from "../stageplots-files.js";
import { broadcastStagePlots, stageplotsPublisher, stagePlotsViewNow } from "../stageplots-publish-instance.js";
import {
  STAGEPLOT_ID,
  addressOwners,
  applyOverride,
  checkItems,
  itemsWithin,
  limitProblem,
  nameProblem,
  readOverrideChange,
  slugFromName,
  stageplotsStore,
  validatePlotInput,
  validateVenueInput,
  venueSlugProblem,
} from "../stageplots-store.js";
import { BodyTooLargeError, type RouteCtx, error, json, readObjectBody, readRawBody } from "./context.js";


const PREFIX = "/api/stageplots";

/** A refusal raised inside a store update, so the update writes nothing. */
class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function newId(prefix: "v" | "p" | "b"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}


function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function answer(res: http.ServerResponse, err: Refused): void {
  json(res, { error: err.message, ...err.extra }, err.status);
}

/**
 * Apply one change, broadcast the result and answer with what `pick` takes
 * from it. A change that hands back the document it was given changed
 * nothing: no write, no broadcast, the same answer. A Refused thrown by
 * `change` answers with its status and writes nothing; anything else is a
 * failed write and goes to the server's handler.
 */
async function mutate(
  res: http.ServerResponse,
  change: (doc: StagePlotsDoc) => StagePlotsDoc,
  pick: (doc: StagePlotsDoc) => unknown,
  status = 200,
  afterSave?: (doc: StagePlotsDoc, changed: boolean) => Promise<string | null>,
): Promise<StagePlotsDoc | null> {
  let doc: StagePlotsDoc;
  let changed = false;
  try {
    doc = await stageplotsStore.update((current) => {
      const next = change(current);
      changed = next !== current;
      return next;
    });
  } catch (err) {
    if (err instanceof Refused) {
      answer(res, err);
      return null;
    }
    console.error(`[stageplots] save failed: ${scrub(errorMessage(err))}`);
    throw err;
  }
  if (changed) broadcastStagePlots(doc);
  // What the drafts could not do after it: said beside the answer, which stays a success.
  const draftNotice = (await afterSave?.(doc, changed)) ?? null;
  const picked = pick(doc);
  json(res, draftNotice ? { ...(picked as object), draftNotice } : picked, status);
  return changed ? doc : null;
}

/**
 * The request's JSON object, or null once a 400 has answered it. A body that is not an object, or
 * is over the cap, is said on [stageplots] as `refused` ("items refused for plot p-1") with why.
 */
async function readBodyOrSay(c: RouteCtx, refused: string): Promise<Record<string, unknown> | null> {
  let body: Record<string, unknown> | null;
  try {
    body = await readObjectBody(c.req, c.res);
  } catch (err) {
    if (err instanceof BodyTooLargeError) console.warn(`[stageplots] ${refused}: ${scrub(err.message)}`);
    throw err;
  }
  if (!body) console.warn(`[stageplots] ${refused}: the body is not a JSON object`);
  return body;
}

function findVenue(doc: StagePlotsDoc, id: string): Venue {
  const v = doc.venues.find((x) => x.id === id);
  if (!v) throw new Refused(404, "no such venue");
  return v;
}

function findPlot(doc: StagePlotsDoc, id: string): Plot {
  const p = doc.plots.find((x) => x.id === id);
  if (!p) throw new Refused(404, "no such plot");
  return p;
}

function orRefuse(problem: string | null, status = 400): void {
  if (problem) throw new Refused(status, problem);
}

/** `list` with `id`'s entry replaced by `next`, or `doc` itself when `next` is
 *  the same as what it replaces field for field: nothing to write. */
function replaceIn<T extends { id: string }>(doc: StagePlotsDoc, key: "venues" | "plots" | "backgrounds", next: T): StagePlotsDoc {
  const list = doc[key] as unknown as T[];
  const now = list.find((x) => x.id === next.id);
  if (now && JSON.stringify(now) === JSON.stringify(next)) return doc;
  return { ...doc, [key]: list.map((x) => (x.id === next.id ? next : x)) };
}

// ── Venues ───────────────────────────────────────────────────────────────

async function createVenue(c: RouteCtx): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  const problem = validateVenueInput(body, { partial: false });
  if (problem) return error(c.res, problem);
  const id = newId("v");
  await mutate(
    c.res,
    (doc) => {
      orRefuse(limitProblem(doc, "venue"));
      const name = (body.name as string).trim();
      const owners = addressOwners(doc.venues);
      const venue: Venue = {
        id,
        name,
        slug: slugFromName(name, (s) => owners.has(s)),
        oldSlugs: [],
        kind: body.kind as VenueKind,
        notes: typeof body.notes === "string" ? body.notes : "",
        plotIds: [],
        defaultPlotId: null,
      };
      return { ...doc, venues: [...doc.venues, venue] };
    },
    (doc) => venueView(findVenue(doc, id)),
    201,
  );
}

/** Why an address change is refused, said on [stageplots] and answered as the sentence the Venues card shows. */
function refuseAddress(id: string, why: string): never {
  console.warn(`[stageplots] address refused for venue ${scrub(id)}: ${scrub(why)}`);
  throw new Refused(400, why);
}

/**
 * The venue's addresses after a PATCH. `oldSlugs` may only leave some of the old addresses out.
 * A new `slug` keeps the one it replaces as an old address (newest last, the oldest dropped past
 * ten) and takes itself off that list if it was one. No other venue may answer to it, by its
 * id, its address or an old one. A rename never reaches here: the address stays.
 */
function addressesAfter(doc: StagePlotsDoc, v: Venue, body: Record<string, unknown>): Pick<Venue, "slug" | "oldSlugs"> {
  let oldSlugs = v.oldSlugs;
  const keep = body.oldSlugs;
  if (keep !== undefined) {
    if (!Array.isArray(keep) || !keep.every((s) => typeof s === "string" && v.oldSlugs.includes(s))) {
      refuseAddress(v.id, "Old addresses can only be dropped from the venue's own list, never added");
    }
    oldSlugs = v.oldSlugs.filter((s) => keep.includes(s));
  }
  let slug = v.slug;
  if (body.slug !== undefined && body.slug !== v.slug) {
    if (body.slug === null) refuseAddress(v.id, "A venue's address can be changed, not removed");
    const problem = venueSlugProblem(body.slug);
    if (problem) refuseAddress(v.id, problem);
    const next = body.slug as string;
    const owner = addressOwners(doc.venues).get(next);
    if (owner && owner.id !== v.id) refuseAddress(v.id, `${owner.name} already uses that address`);
    oldSlugs = oldSlugs.filter((s) => s !== next);
    if (slug !== null) oldSlugs = [...oldSlugs, slug].slice(-STAGEPLOT_LIMITS.oldSlugs);
    slug = next;
  }
  return { slug, oldSlugs };
}

async function updateVenue(c: RouteCtx, id: string): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  const problem = validateVenueInput(body, { partial: true });
  if (problem) return error(c.res, problem);
  const order = body.plotIds;
  let before = null as Venue | null;
  const saved = await mutate(
    c.res,
    (doc) => {
      const v = findVenue(doc, id);
      before = v;
      // A new tab order is a list of strings naming exactly the venue's plots, each once:
      // anything else would drop or duplicate a plot, so it is refused whole.
      if (
        order !== undefined &&
        (!Array.isArray(order) ||
          !order.every((x) => typeof x === "string") ||
          order.length !== v.plotIds.length ||
          new Set(order).size !== order.length ||
          !order.every((x) => v.plotIds.includes(x as string)))
      ) {
        console.warn(`[stageplots] plot order refused for venue ${scrub(id)}: it is not each of its ${scrub(v.plotIds.length)} plot ids once`);
        throw new Refused(400, "plotIds must name each of the venue's plots exactly once");
      }
      return replaceIn<Venue>(doc, "venues", {
        ...v,
        ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
        ...(body.kind !== undefined ? { kind: body.kind as VenueKind } : {}),
        ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        ...(order !== undefined ? { plotIds: order as string[] } : {}),
        ...addressesAfter(doc, v, body),
      });
    },
    (doc) => venueView(findVenue(doc, id)),
  );
  if (saved && before) logAddressChange(before, findVenue(saved, id));
}

/** An address change, and old addresses dropped, said on [stageplots]: each changes what a link or QR code opens. */
function logAddressChange(was: Venue, now: Venue): void {
  const from = was.slug ?? was.id;
  const to = now.slug ?? now.id;
  if (from !== to) console.log(`[stageplots] venue ${scrub(now.id)} now at /stageplots/${scrub(to)}; /stageplots/${scrub(from)} still opens it`);
  const dropped = was.oldSlugs.filter((s) => !now.oldSlugs.includes(s) && s !== now.slug);
  if (dropped.length > 0) console.log(`[stageplots] venue ${scrub(now.id)} no longer answers to ${scrub(dropped.map((s) => `/stageplots/${s}`).join(", "))}`);
}

async function deleteVenue(c: RouteCtx, id: string): Promise<void> {
  // A published venue is unpublished first, by the publisher: its link removed from the page, or
  // queued for removal when the page cannot take it, so no link is left that nothing knows of.
  const retired = await stageplotsPublisher.retireForDelete(id);
  // Refused while a config restore lands: deleting the venue then would leave its link live and unknown.
  if (!retired.ok) {
    console.warn(`[stageplots] venue ${scrub(id)} not deleted: ${scrub(retired.error)}`);
    json(c.res, { error: retired.error }, retired.status);
    return;
  }
  const notice = retired.notice;
  let plotIds: string[] = [];
  let drafts = 0;
  const doc = await mutate(
    c.res,
    (d) => {
      findVenue(d, id);
      plotIds = d.plots.filter((p) => p.venueId === id).map((p) => p.id);
      return {
        ...d,
        venues: d.venues.filter((v) => v.id !== id),
        plots: d.plots.filter((p) => p.venueId !== id),
        overrides: d.overrides.filter((o) => o.venueId !== id),
      };
    },
    () => (notice ? { ok: true, notice } : { ok: true }),
    200,
    (_, changed) =>
      changed
        ? draftsAfter("The venue was deleted, but the unsaved drafts of its plots could not be deleted with it", async () => {
            drafts = await dropDrafts(plotIds);
          })
        : Promise.resolve(null),
  );
  if (doc) console.log(`[stageplots] venue ${scrub(id)} deleted, with its plots and plan overrides${drafts > 0 ? ` and ${scrub(drafts)} unsaved drafts` : ""}`);
}

async function setDefault(c: RouteCtx, id: string): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  await mutate(
    c.res,
    (doc) => {
      const v = findVenue(doc, id);
      if (typeof body.plotId !== "string" || !v.plotIds.includes(body.plotId)) throw new Refused(400, "plotId must be one of the venue's plots");
      return replaceIn<Venue>(doc, "venues", { ...v, defaultPlotId: body.plotId });
    },
    (doc) => venueView(findVenue(doc, id)),
  );
}

// ── Plots ────────────────────────────────────────────────────────────────

function knownBackground(doc: StagePlotsDoc, id: unknown): string | null {
  if (id === null || id === undefined) return null;
  if (typeof id !== "string" || !doc.backgrounds.some((b) => b.id === id)) throw new Refused(400, "no such background");
  return id;
}

async function createPlot(c: RouteCtx): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  const problem = validatePlotInput(body, { partial: false });
  if (problem) return error(c.res, problem);
  const id = newId("p");
  await mutate(
    c.res,
    (doc) => {
      const venue = doc.venues.find((v) => v.id === body.venueId);
      if (!venue) throw new Refused(400, "no such venue");
      orRefuse(limitProblem(doc, "plot", venue.id));
      const plot: Plot = {
        id,
        venueId: venue.id,
        name: (body.name as string).trim(),
        backgroundId: knownBackground(doc, body.backgroundId),
        bgFade: typeof body.bgFade === "number" ? body.bgFade : 0.4,
        items: [],
        version: 0,
      };
      const v: Venue = { ...venue, plotIds: [...venue.plotIds, id], defaultPlotId: venue.defaultPlotId ?? id };
      return { ...doc, plots: [...doc.plots, plot], venues: doc.venues.map((x) => (x.id === v.id ? v : x)) };
    },
    (doc) => findPlot(doc, id),
    201,
  );
}

async function duplicatePlot(c: RouteCtx, sourceId: string): Promise<void> {
  const id = newId("p");
  await mutate(
    c.res,
    (doc) => {
      const source = findPlot(doc, sourceId);
      orRefuse(limitProblem(doc, "plot", source.venueId));
      const copy: Plot = {
        ...structuredClone(source),
        id,
        name: `${source.name} copy`.slice(0, STAGEPLOT_LIMITS.nameChars),
        version: 0,
      };
      const venues = doc.venues.map((v) => {
        if (v.id !== source.venueId) return v;
        const at = v.plotIds.indexOf(sourceId) + 1;
        return { ...v, plotIds: [...v.plotIds.slice(0, at), id, ...v.plotIds.slice(at)] };
      });
      return { ...doc, plots: [...doc.plots, copy], venues };
    },
    (doc) => findPlot(doc, id),
    201,
  );
}

async function updatePlot(c: RouteCtx, id: string): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  const problem = validatePlotInput(body, { partial: true });
  if (problem) return error(c.res, problem);
  let moved = 0;
  const saved = await mutate(
    c.res,
    (doc) => {
      const p = findPlot(doc, id);
      const backgroundId = body.backgroundId !== undefined ? knownBackground(doc, body.backgroundId) : p.backgroundId;
      // A background that makes the plot shorter would leave an item low on the
      // old one below the bottom edge, out of sight and unsaveable: it comes up
      // to the edge instead.
      const within = itemsWithin(p.items, plotHeight(doc.backgrounds.find((b) => b.id === backgroundId)));
      moved = within.moved;
      const next = replaceIn<Plot>(doc, "plots", {
        ...p,
        ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
        backgroundId,
        ...(typeof body.bgFade === "number" ? { bgFade: body.bgFade } : {}),
        items: within.items,
      });
      // A real change bumps the version; nothing to change leaves it alone.
      return next === doc ? doc : replaceIn<Plot>(next, "plots", { ...findPlot(next, id), version: p.version + 1 });
    },
    (doc) => findPlot(doc, id),
    200,
    // A rename, a fade or a background that moved no item changes the version and not the items:
    // a draft based on the version before is still based on these items, and keeps working.
    (doc, changed) => {
      const now = doc.plots.find((p) => p.id === id);
      if (!changed || !now || moved > 0) return Promise.resolve(null);
      return draftsAfter("Saved, but the plot's unsaved draft could not be moved onto this version, so it may open as saved elsewhere", () =>
        carryDraftBase(id, now.version - 1, now.version),
      );
    },
  );
  // Only once the move is saved: a refused change moved nothing.
  if (saved && moved > 0) console.log(`[stageplots] plot ${scrub(id)}: ${scrub(moved)} items moved up onto the plot after its background changed`);
}

/** Why a PUT …/items body is refused, said on [stageplots] and answered. */
function refuseItems(id: string, status: number, why: string, extra: Record<string, unknown> = {}): never {
  console.warn(`[stageplots] items refused for plot ${scrub(id)}: ${scrub(why)}`);
  throw new Refused(status, why, extra);
}

/**
 * Save a plot's whole item list against the version the editor loaded. The
 * version is checked inside the store's serialized update, so of two saves
 * from one version exactly one lands and the other is 409. An item list equal
 * to the stored one changes nothing: no write, no broadcast, no new version.
 */
async function saveItems(c: RouteCtx, id: string): Promise<void> {
  const body = await readBodyOrSay(c, `items refused for plot ${scrub(id)}`);
  if (!body) return;
  const version = body.version;
  await mutate(
    c.res,
    (doc) => {
      if (!doc.plots.some((x) => x.id === id)) refuseItems(id, 404, "no such plot");
      const p = findPlot(doc, id);
      if (typeof version !== "number" || !Number.isInteger(version) || version < 0) refuseItems(id, 400, "version must be a whole number");
      let items;
      try {
        items = checkItems(body.items, plotHeight(doc.backgrounds.find((b) => b.id === p.backgroundId)), "the plot");
      } catch (err) {
        refuseItems(id, 400, errorMessage(err));
      }
      if (version !== p.version) refuseItems(id, 409, "changed elsewhere", { version: p.version });
      if (JSON.stringify(items) === JSON.stringify(p.items)) return doc;
      return replaceIn<Plot>(doc, "plots", { ...p, items, version: p.version + 1 });
    },
    (doc) => ({ plot: findPlot(doc, id) }),
    200,
    // A save that went through, changed or not, is what the plot's draft was kept for: it goes
    // before the answer, so the editor never reads back a draft of what it just saved.
    () => draftsAfter("Saved, but the plot's unsaved draft could not be deleted, so it may open again", () => dropDraft(id)),
  );
}

/**
 * Delete a plot, and the overrides that named it: a plan whose override is
 * gone shows its venue's default. Deleting the default makes the first plot
 * left in tab order the default, and deleting the last plot leaves the venue
 * with none. The answer lists the cleared plans and the venue's default as it now is, and the
 * log says both (the editor's confirm named them before the delete was sent).
 */
async function deletePlot(c: RouteCtx, id: string): Promise<void> {
  let drafts = 0;
  let cleared: string[] = [];
  let nowDefault: string | null = null;
  let wasDefault = false;
  const saved = await mutate(
    c.res,
    (doc) => {
      const p = findPlot(doc, id);
      const venue = findVenue(doc, p.venueId);
      const plotIds = venue.plotIds.filter((x) => x !== id);
      wasDefault = venue.defaultPlotId === id;
      nowDefault = wasDefault ? (plotIds[0] ?? null) : venue.defaultPlotId;
      cleared = overridesOfPlot(doc, id).map((o) => o.planId);
      return {
        ...doc,
        plots: doc.plots.filter((x) => x.id !== id),
        venues: doc.venues.map((v) => (v.id === venue.id ? { ...v, plotIds, defaultPlotId: nowDefault } : v)),
        overrides: doc.overrides.filter((o) => o.plotId !== id),
      };
    },
    () => ({ ok: true, clearedPlans: cleared, defaultPlotId: nowDefault }),
    200,
    (_, changed) =>
      changed
        ? draftsAfter("The plot was deleted, but its unsaved draft could not be deleted with it", async () => {
            drafts = await dropDrafts([id]);
          })
        : Promise.resolve(null),
  );
  if (!saved) return;
  if (drafts > 0) console.log(`[stageplots] plot ${scrub(id)} deleted with its unsaved draft`);
  if (cleared.length > 0) {
    console.log(`[stageplots] plot ${scrub(id)} deleted; ${scrub(cleared.length)} plan overrides cleared (plans ${scrub(cleared.join(", "))}), which show the default now`);
  }
  if (wasDefault) {
    console.log(`[stageplots] plot ${scrub(id)} was its venue's default; ${nowDefault ? `plot ${scrub(nowDefault)} is the default now` : "the venue has no plots left"}`);
  }
}

// ── Drafts ───────────────────────────────────────────────────────────────

/** What stageplots:drafts carries: which plots have a draft, and since when. Never the items. */
const draftNotes = (drafts: readonly PlotDraft[]): PlotDraftNotes => ({ drafts: drafts.map((d) => ({ plotId: d.plotId, savedAt: d.savedAt })) });

/** Change the drafts and, when that changed anything, say which plots have one now on stageplots:drafts. A failed write is said on [stageplots] and thrown. */
async function changeDrafts(fn: (drafts: PlotDraft[]) => PlotDraft[]): Promise<PlotDraft[]> {
  let changed = false;
  let saved: PlotDraft[];
  try {
    saved = await plotDraftsStore.update((drafts) => {
      const next = fn(drafts);
      changed = next !== drafts;
      return next;
    });
  } catch (err) {
    console.error(`[stageplots] a draft could not be written: ${scrub(errorMessage(err))}`);
    throw err;
  }
  if (changed && channelHasSubscribers(STAGEPLOT_DRAFTS_CHANNEL)) broadcast(STAGEPLOT_DRAFTS_CHANNEL, draftNotes(saved));
  return saved;
}

/** Delete one plot's draft, if it has one. */
function dropDraft(plotId: string): Promise<PlotDraft[]> {
  return changeDrafts((drafts) => (drafts.some((d) => d.plotId === plotId) ? drafts.filter((d) => d.plotId !== plotId) : drafts));
}

/**
 * A drafts change after a save, delete or rename that has landed. Its failure never makes that
 * a failure: changeDrafts has said it on [stageplots], and it is answered as the `draftNotice`
 * the editor shows beside its banner.
 */
async function draftsAfter(what: string, fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return `${what}: ${errorMessage(err)}`;
  }
}

/** Delete the drafts of `plotIds`, plots a delete has just removed, and only those. Resolves to how many went. */
async function dropDrafts(plotIds: readonly string[]): Promise<number> {
  const gone = new Set(plotIds);
  let dropped = 0;
  await changeDrafts((drafts) => {
    const kept = drafts.filter((d) => !gone.has(d.plotId));
    dropped = drafts.length - kept.length;
    return dropped > 0 ? kept : drafts;
  });
  return dropped;
}

/** A draft based on `from` is based on `to` now: the plot changed and its items did not. */
async function carryDraftBase(plotId: string, from: number, to: number): Promise<void> {
  await changeDrafts((drafts) =>
    drafts.some((d) => d.plotId === plotId && d.baseVersion === from) ? drafts.map((d) => (d.plotId === plotId && d.baseVersion === from ? { ...d, baseVersion: to } : d)) : drafts,
  );
}

/** The orphans last said, so each editor mount does not say them again. */
let saidOrphans = "";

/**
 * Every draft whose plot exists. One whose plot is not there (deleted while the drafts could not
 * be written, a restore that brought other plots, or a stageplots.json that cannot be read and
 * answers no plots at all) is left out of the answer and said once, and never deleted here: a
 * read that deleted on what it could not see would take every draft with a damaged file.
 */
async function listDrafts(c: RouteCtx): Promise<void> {
  const [doc, drafts] = await Promise.all([stageplotsStore.get(), plotDraftsStore.all()]);
  const plots = new Set(doc.plots.map((p) => p.id));
  const orphans = drafts.filter((d) => !plots.has(d.plotId)).map((d) => d.plotId);
  const said = orphans.join(",");
  if (said !== saidOrphans && orphans.length > 0) {
    console.warn(`[stageplots] ${scrub(orphans.length)} unsaved drafts left out: their plots are not in stageplots.json (${scrub(orphans.join(", "))}); they stay in stageplot-drafts.json`);
  }
  saidOrphans = said;
  json(c.res, { drafts: drafts.filter((d) => plots.has(d.plotId)) });
}

/** Why a draft is refused, said on [stageplots] and answered. */
function refuseDraft(res: http.ServerResponse, id: string, status: number, why: string): void {
  console.warn(`[stageplots] draft refused for plot ${scrub(id)}: ${scrub(why)}`);
  json(res, { error: why }, status);
}

/** Keep a plot's unsaved items: held to a save's rules, never written to the plot. */
async function putDraft(c: RouteCtx, id: string): Promise<void> {
  const body = await readBodyOrSay(c, `draft refused for plot ${scrub(id)}`);
  if (!body) return;
  const doc = await stageplotsStore.get();
  const plot = doc.plots.find((p) => p.id === id);
  if (!plot) return refuseDraft(c.res, id, 404, "no such plot");
  const baseVersion = body.baseVersion;
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) return refuseDraft(c.res, id, 400, "baseVersion must be a whole number");
  let items;
  try {
    items = checkItems(body.items, plotHeight(doc.backgrounds.find((b) => b.id === plot.backgroundId)), "the plot");
  } catch (err) {
    return refuseDraft(c.res, id, 400, errorMessage(err));
  }
  const draft: PlotDraft = { plotId: id, baseVersion, items, savedAt: new Date().toISOString() };
  await changeDrafts((drafts) => [...drafts.filter((d) => d.plotId !== id), draft]);
  json(c.res, { plotId: id, baseVersion, savedAt: draft.savedAt });
}

async function deleteDraft(c: RouteCtx, id: string): Promise<void> {
  await dropDraft(id);
  json(c.res, { ok: true });
}

// ── Overrides ────────────────────────────────────────────────────────────

/**
 * Give one plan a plot other than its venue's default, or (plotId null) hand
 * it back to the default. The same plot again, or removing an override that
 * is not there, writes and broadcasts nothing. A real change is said on
 * [stageplots], since it changes what /stageplots shows that week; every
 * refusal is said there too, with why.
 */
async function saveOverride(c: RouteCtx): Promise<void> {
  const body = await readBodyOrSay(c, "override refused");
  if (!body) return;
  const change = readOverrideChange(body);
  if ("problem" in change) {
    console.warn(`[stageplots] override refused: ${scrub(change.problem)}`);
    return error(c.res, change.problem);
  }
  let names: { venueName: string; plotName: string | null } | null = null;
  const saved = await mutate(
    c.res,
    (doc) => {
      const next = applyOverride(doc, change);
      if ("problem" in next) {
        console.warn(`[stageplots] override refused for plan ${scrub(change.planId)}, venue ${scrub(change.venueId)}: ${scrub(next.problem)}`);
        throw new Refused(next.status, next.problem);
      }
      names = next;
      return next.doc;
    },
    stagePlotsViewNow,
  );
  if (!saved || !names) return;
  const { venueName, plotName } = names as { venueName: string; plotName: string | null };
  if (plotName === null) console.log(`[stageplots] plan ${scrub(change.planId)}: ${scrub(venueName)} back to its default plot`);
  else console.log(`[stageplots] plan ${scrub(change.planId)}: ${scrub(venueName)} shows "${scrub(plotName)}" for that plan`);
}

// ── Backgrounds ──────────────────────────────────────────────────────────

/**
 * Say on [stageplots] why an upload is refused, and refuse it: `why` is logged
 * after the name, and answered as it is unless `answer` says it better.
 */
function refuseUpload(name: string, size: number | null, why: string, opts: { status?: number; answer?: string } = {}): never {
  console.warn(`[stageplots] upload refused: "${scrub(name)}"${size === null ? "" : ` (${scrub(kb(size))})`} ${scrub(why)}`);
  throw new Refused(opts.status ?? 400, opts.answer ?? why);
}

/** The upload's name off ?name=, or a refusal said on [stageplots]. */
function uploadName(url: URL): string {
  const name = (url.searchParams.get("name") ?? "").trim();
  const problem = nameProblem(name, "the background");
  if (problem) refuseUpload(name || "(no name)", null, problem);
  return name;
}

/**
 * The upload's bytes, at most `cap`, viewed without a copy. One over the cap is
 * said on [stageplots] and answered 413 by the server.
 */
async function uploadBytes(c: RouteCtx, name: string, cap: number): Promise<Buffer> {
  let raw: Uint8Array;
  try {
    raw = await readRawBody(c.req, cap);
  } catch (err) {
    if (err instanceof BodyTooLargeError) console.warn(`[stageplots] upload refused: "${scrub(name)}" is over the ${scrub(kb(cap))} cap`);
    throw err;
  }
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

/** sniffUpload, saying so on [stageplots] when sharp itself will not load (a 500). */
async function sniffOrSay(bytes: Buffer): ReturnType<typeof sniffUpload> {
  try {
    return await sniffUpload(bytes);
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause;
    console.error(`[stageplots] ${scrub(errorMessage(err))}${cause ? `: ${scrub(errorMessage(cause), 600)}` : ""}`);
    throw err;
  }
}

async function answerRefusal(res: http.ServerResponse, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    answer(res, err);
  }
}

async function uploadPdf(c: RouteCtx): Promise<void> {
  await answerRefusal(c.res, async () => {
    const name = uploadName(c.url);
    const bytes = await uploadBytes(c, name, STAGEPLOT_LIMITS.pdfBytes);
    const sniffed = await sniffOrSay(bytes);
    if (!("kind" in sniffed) || sniffed.kind !== "pdf") refuseUpload(name, bytes.length, "is not a PDF", { answer: "the upload is not a PDF" });
    // PDFs waiting for their page are bounded: an hour-old one is tidied first,
    // and past MAX_PENDING_ORIGINALS a new one is refused.
    const doc = await stageplotsStore.get();
    await tidyStagePlotFiles(stageplotsStore);
    const pending = await pendingOriginals(doc);
    if (pending.length >= MAX_PENDING_ORIGINALS && !pending.includes(contentName(bytes, "pdf"))) {
      refuseUpload(
        name,
        bytes.length,
        `the server already holds ${pending.length} PDFs waiting for their page; finish those uploads, or try again within the hour`,
        { status: 409 },
      );
    }
    let originalHash: string;
    try {
      originalHash = await storeStagePlotOriginal(bytes);
    } catch (err) {
      refuseUpload(name, bytes.length, errorMessage(err));
    }
    console.log(`[stageplots] PDF "${scrub(name)}" kept (${scrub(kb(bytes.length))}); waiting for its page`);
    json(c.res, { originalHash, bytes: bytes.length }, 201);
  });
}

function pageParam(name: string, url: URL, key: string): number {
  const n = Number(url.searchParams.get(key));
  if (!Number.isInteger(n) || n < 1 || n > 10_000) refuseUpload(name, null, `?${key}= must be a page number`);
  return n;
}

async function uploadImage(c: RouteCtx): Promise<void> {
  await answerRefusal(c.res, async () => {
    const name = uploadName(c.url);
    const originalParam = c.url.searchParams.get("original");
    const pdf = originalParam === null ? null : { hash: originalParam, page: pageParam(name, c.url, "page"), pages: pageParam(name, c.url, "pages") };
    if (pdf && pdf.page > pdf.pages) refuseUpload(name, null, "?page= is past the last page");
    const limit = limitProblem(await stageplotsStore.get(), "background");
    if (limit) refuseUpload(name, null, limit);

    const bytes = await uploadBytes(c, name, STAGEPLOT_LIMITS.imageBytes);
    const sniffed = await sniffOrSay(bytes);
    if ("problem" in sniffed) refuseUpload(name, bytes.length, sniffed.problem, { answer: `the upload ${sniffed.problem}` });
    if (sniffed.kind === "pdf") {
      const why = "is a PDF: upload it to /api/stageplots/backgrounds/pdf, then its page";
      refuseUpload(name, bytes.length, why, { answer: `the upload ${why}` });
    }
    const originalBytes = pdf ? await stagePlotOriginalBytes(pdf.hash) : null;
    if (pdf && originalBytes === null) refuseUpload(name, bytes.length, "the PDF this page came from is not on the server; upload it again");

    const ext = sniffed.kind === "png" ? "png" : "jpg";
    let prepared;
    try {
      prepared = await prepareBackground(bytes, { kind: sniffed.kind, cleanup: true });
    } catch (err) {
      console.warn(`[stageplots] conversion failed for "${scrub(name)}": ${scrub(errorMessage(err))}`);
      throw new Refused(400, errorMessage(err));
    }
    const { source, converted } = prepared;
    // The source is re-encoded (2400 px, sRGB), so it is not the upload and not held to its cap:
    // one over what the image store keeps is refused by name here, not a 500 from the store.
    if (source.length > STAGEPLOT_LIMITS.imageBytes) {
      const why = `is over 12 MB once brought to 2400 px in sRGB (${kb(source.length)}); save it as a JPEG and upload that`;
      refuseUpload(name, bytes.length, why, { answer: `the upload ${why}` });
    }
    // The source as stored, 2400 px and no metadata, is a PNG or JPEG upload's original too.
    const sourceHash = await storeStagePlotImage(source, ext);
    const convertedHash = await storeStagePlotImage(converted.webp, "webp");
    const background: Background = {
      id: newId("b"),
      name,
      original: pdf
        ? { hash: pdf.hash, mime: "application/pdf", bytes: originalBytes ?? 0 }
        : { hash: sourceHash, mime: ext === "png" ? "image/png" : "image/jpeg", bytes: source.length },
      source: { hash: sourceHash, ext },
      converted: { hash: convertedHash, width: converted.width, height: converted.height, bytes: converted.webp.length },
      cleanup: true,
      pdfPage: pdf?.page ?? null,
      pdfPages: pdf?.pages ?? null,
    };
    const doc = await mutate(
      c.res,
      (d) => {
        orRefuse(limitProblem(d, "background"));
        return { ...d, backgrounds: [...d.backgrounds, background] };
      },
      () => backgroundView(background),
      201,
    );
    if (!doc) return;
    const from = pdf ? `PDF page ${pdf.page} of ${pdf.pages}` : sniffed.kind.toUpperCase();
    console.log(
      `[stageplots] background "${scrub(name)}" accepted: ${scrub(from)}, ${scrub(kb(bytes.length))} -> ${scrub(converted.width)}x${scrub(converted.height)} WebP ${scrub(kb(converted.webp.length))}, source kept at ${scrub(kb(source.length))}`,
    );
    if (converted.webp.length >= CONVERTED_MAX_BYTES) {
      console.warn(`[stageplots] background "${scrub(name)}" is ${scrub(kb(converted.webp.length))} even at the lowest quality; kept`);
    }
  });
}

async function updateBackground(c: RouteCtx, id: string): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  await answerRefusal(c.res, async () => {
    if (body.name !== undefined) orRefuse(nameProblem(body.name, "the background"));
    if (body.cleanup !== undefined && typeof body.cleanup !== "boolean") throw new Refused(400, "cleanup must be true or false");
    const current = (await stageplotsStore.get()).backgrounds.find((b) => b.id === id);
    if (!current) throw new Refused(404, "no such background");

    let converted: Background["converted"] | null = null;
    if (typeof body.cleanup === "boolean" && body.cleanup !== current.cleanup) {
      const source = await readStagePlotSource(current.source.hash, current.source.ext);
      if (!source) {
        console.warn(`[stageplots] re-conversion refused for background ${scrub(id)}: its source image is missing from the server`);
        throw new Refused(409, "the image this background was converted from is missing from the server; upload it again");
      }
      try {
        const out = await convertBackground(source, { cleanup: body.cleanup });
        converted = { hash: await storeStagePlotImage(out.webp, "webp"), width: out.width, height: out.height, bytes: out.webp.length };
      } catch (err) {
        console.warn(`[stageplots] re-conversion failed for background ${scrub(id)}: ${scrub(errorMessage(err))}`);
        throw err;
      }
    }
    const doc = await mutate(
      c.res,
      (d) => {
        const b = d.backgrounds.find((x) => x.id === id);
        if (!b) throw new Refused(404, "no such background");
        return replaceIn<Background>(d, "backgrounds", {
          ...b,
          ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
          ...(converted ? { converted, cleanup: body.cleanup as boolean } : {}),
        });
      },
      (d) => backgroundView(d.backgrounds.find((x) => x.id === id)!),
    );
    if (doc && converted) {
      console.log(`[stageplots] background ${scrub(id)} re-converted with clean-up ${scrub(body.cleanup ? "on" : "off")}: ${scrub(kb(converted.bytes))}`);
      await tidyStagePlotFiles(stageplotsStore);
    }
  });
}

async function deleteBackground(c: RouteCtx, id: string): Promise<void> {
  const doc = await mutate(
    c.res,
    (d) => {
      if (!d.backgrounds.some((b) => b.id === id)) throw new Refused(404, "no such background");
      const users = plotsUsing(d, id).map((u) => `${u.venue} · ${u.plot}`);
      if (users.length > 0) throw new Refused(409, `the background is used by ${users.join(", ")}`, { plots: users });
      return { ...d, backgrounds: d.backgrounds.filter((b) => b.id !== id) };
    },
    () => ({ ok: true }),
  );
  if (!doc) return;
  console.log(`[stageplots] background ${scrub(id)} deleted`);
  await tidyStagePlotFiles(stageplotsStore);
}

// ── Publishing ───────────────────────────────────────────────────────────

const PUBLISH_ACTIONS = new Map([
  ["publish", (id: string) => stageplotsPublisher.publish(id)],
  ["regenerate", (id: string) => stageplotsPublisher.regenerate(id)],
  ["unpublish", (id: string) => stageplotsPublisher.unpublish(id)],
  ["publish-now", (id: string) => stageplotsPublisher.publishNow(id)],
]);

/** One publish action on a venue. What it said and logged is the publisher's; this answers it. */
async function publishAction(c: RouteCtx, action: string, id: string, run: (id: string) => ReturnType<typeof stageplotsPublisher.publish>): Promise<void> {
  const r = await run(id);
  // Every other refusal is said by the publisher; this one, a restore landing, is said here.
  if (!r.ok && r.status === 503) console.warn(`[stageplots] ${scrub(action)} refused for venue ${scrub(id)}: ${scrub(r.error)}`);
  // A notice rides beside the venue: something done that the operator should know about (a copy
  // left on a page this server can no longer reach).
  if (r.ok) json(c.res, { ...venueView(r.venue), ...(r.notice ? { notice: r.notice } : {}) });
  else json(c.res, { error: r.error }, r.status);
}

/** Show a published venue on its page's landing page, or take it off. */
async function setListed(c: RouteCtx, id: string): Promise<void> {
  const body = await readObjectBody(c.req, c.res);
  if (!body) return;
  const listed = body.listed;
  if (typeof listed !== "boolean") {
    console.warn(`[stageplots] landing page listing refused for venue ${scrub(id)}: listed is not true or false`);
    return error(c.res, "listed must be true or false");
  }
  await publishAction(c, "landing page listing", id, (venueId) => stageplotsPublisher.setListed(venueId, listed));
}

/** The venue's public link, for the manage page's Publish card: the one answer that carries a secret (VenueLink). */
async function venueLink(c: RouteCtx, id: string): Promise<void> {
  const venue = (await stageplotsStore.get()).venues.find((v) => v.id === id);
  if (!venue) return error(c.res, "no such venue", 404);
  const link: VenueLink = { url: venue.publish ? `${venue.publish.origin}${STAGEPLOTS_PATH}/${venue.publish.secret}` : null };
  json(c.res, link);
}

/** Remove now: every old link queued against the page set up is dropped from it. Answers how many went, failed and wait for another page. */
async function removePending(c: RouteCtx): Promise<void> {
  const r = await stageplotsPublisher.removePending();
  if ("error" in r) {
    console.warn(`[stageplots] Remove now refused: ${scrub(r.error)}`);
    json(c.res, { error: r.error }, r.status);
  } else json(c.res, r);
}

// ── Dispatch ─────────────────────────────────────────────────────────────

/** The id in `/api/stageplots/<kind>/<id>[/<action>]`, or null. */
function idIn(pathname: string, kind: string, action?: string): string | null {
  const parts = pathname.slice(PREFIX.length + 1).split("/");
  if (parts[0] !== kind || parts.length !== (action ? 3 : 2) || (action && parts[2] !== action)) return null;
  const id = decodeURIComponent(parts[1] ?? "");
  return STAGEPLOT_ID.test(id) ? id : null;
}

export async function stageplotsRoutes(c: RouteCtx): Promise<void> {
  const { pathname, method } = c;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return;

  if (pathname === PREFIX && method === "GET") return json(c.res, stagePlotsViewNow(await stageplotsStore.get()));
  if (pathname === `${PREFIX}/patch` && method === "GET") return json(c.res, await patchStore.loadStrict());
  if (pathname === `${PREFIX}/venues` && method === "POST") return createVenue(c);
  if (pathname === `${PREFIX}/plots` && method === "POST") return createPlot(c);
  if (pathname === `${PREFIX}/backgrounds` && method === "POST") return uploadImage(c);
  if (pathname === `${PREFIX}/backgrounds/pdf` && method === "POST") return uploadPdf(c);
  if (pathname === `${PREFIX}/overrides` && method === "PUT") return saveOverride(c);
  if (pathname === `${PREFIX}/pending/remove` && method === "POST") return removePending(c);
  if (pathname === `${PREFIX}/drafts` && method === "GET") return listDrafts(c);

  let id = idIn(pathname, "venues", "default");
  if (id && method === "POST") return setDefault(c, id);
  id = idIn(pathname, "venues", "link");
  if (id && method === "GET") return venueLink(c, id);
  id = idIn(pathname, "venues", "listed");
  if (id && method === "POST") return setListed(c, id);
  for (const [action, run] of PUBLISH_ACTIONS) {
    const venueId = idIn(pathname, "venues", action);
    if (venueId && method === "POST") return publishAction(c, action, venueId, run);
  }
  id = idIn(pathname, "plots", "duplicate");
  if (id && method === "POST") return duplicatePlot(c, id);
  id = idIn(pathname, "plots", "items");
  if (id && method === "PUT") return saveItems(c, id);
  id = idIn(pathname, "plots", "draft");
  if (id && method === "PUT") return putDraft(c, id);
  if (id && method === "DELETE") return deleteDraft(c, id);
  id = idIn(pathname, "venues");
  if (id && method === "PATCH") return updateVenue(c, id);
  if (id && method === "DELETE") return deleteVenue(c, id);
  id = idIn(pathname, "plots");
  if (id && method === "PATCH") return updatePlot(c, id);
  if (id && method === "DELETE") return deletePlot(c, id);
  id = idIn(pathname, "backgrounds");
  if (id && method === "PATCH") return updateBackground(c, id);
  if (id && method === "DELETE") return deleteBackground(c, id);
}
