// stageplots-store.ts — venues, backgrounds and plots, in one config store
// (stageplots.json). The images a background names live in the image folders
// (stageplots-files.ts); this file holds only their hashes.
//
// The rules here are the ones the routes apply on a save, and a restore is held
// to the same ones through checkStagePlotsDoc. Every id a document names
// resolves: a plot's venue and background exist, a venue lists exactly its own
// plots, and its default is one of them.

import { PATCH_COLORS } from "../types/patch.js";
import { STAGEPLOTS_HASH, STAGEPLOTS_ID, isStagePlotsSecret } from "../types/servicecue-publish.js";
import {
  ITEM_TYPES,
  PLOT_UNITS_WIDE,
  STAGEPLOT_LIMITS,
  SYMBOL_KINDS,
  TEXT_KINDS,
  type Background,
  type BackgroundOriginalMime,
  type BackgroundSourceExt,
  type CablePoint,
  type ItemType,
  type Plot,
  type PlotItem,
  type PlotOverride,
  type StagePlotsDoc,
  type SymbolKind,
  type TextKind,
  type Venue,
  type VenueKind,
  type VenuePublish,
} from "../types/stageplots.js";
import { DataStore } from "./data-store.js";
import { errorMessage } from "./errors.js";
import { isRecord } from "./is-record.js";
import { asArray, asObject, checked, refuse, required, textList, uniqueIds } from "./restore-check.js";
import { fitToHeight, plotHeight, withCableBox } from "./stageplots-doc.js";

const EMPTY: StagePlotsDoc = { venues: [], backgrounds: [], plots: [], overrides: [] };

/** Ids the server mints and routes put in a URL: letters, digits, `-` and `_`. The
 *  publish contract's, so a plot id is always one the public page can carry. */
export const STAGEPLOT_ID = STAGEPLOTS_ID;
/** A content name's hash: the first 16 hex of a SHA-256 (image-files.ts). */
export const STAGEPLOT_HASH = STAGEPLOTS_HASH;

const KINDS: readonly VenueKind[] = ["home", "offsite"];
const ORIGINAL_MIMES: readonly BackgroundOriginalMime[] = ["image/png", "image/jpeg", "application/pdf"];
const SOURCE_EXTS: readonly BackgroundSourceExt[] = ["png", "jpg"];

/** A Planning Center plan id as an override names it: what STAGEPLOT_ID allows. */
function planIdProblem(v: unknown): string | null {
  return typeof v === "string" && STAGEPLOT_ID.test(v) ? null : "the plan id must be 1 to 80 letters, digits, - or _";
}

/** The longest plan date taken, in characters: an ISO instant with an offset is 29. */
const PLAN_DATE_CHARS = 40;

/** An ISO date with a time on it. A bare date would be read as midnight UTC,
 *  which is the evening before across the Americas. */
const PLAN_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * A plan date as stored: null, or the ISO instant `v` names, in toISOString's
 * one spelling, so the same instant always compares equal. A string over 40
 * characters, without a time, or one Date cannot read, is a refusal (thrown).
 */
function planDateOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const at = typeof v === "string" && v.length <= PLAN_DATE_CHARS && PLAN_DATE_TIME.test(v) ? Date.parse(v) : NaN;
  if (!Number.isFinite(at)) refuse("the plan date must be an ISO date and time, or null");
  return new Date(at).toISOString();
}

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
  override: `there can be at most ${STAGEPLOT_LIMITS.overrides} overrides`,
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

/** The longest last-error sentence kept. */
const PUBLISH_ERROR_CHARS = 600;
/** The most earlier secrets a venue keeps waiting to be removed. */
const PUBLISH_RETIRED_MAX = 20;

function isoInstant(v: unknown, what: string): string {
  const at = typeof v === "string" && v.length <= PLAN_DATE_CHARS && PLAN_DATE_TIME.test(v) ? Date.parse(v) : NaN;
  if (!Number.isFinite(at)) refuse(`${what} must be an ISO date and time`);
  return new Date(at).toISOString();
}

/** A list of `what`, each passing `ok`, at most `max`, sorted and without repeats. */
function sortedSet(v: unknown, max: number, ok: (x: unknown) => boolean, what: string): string[] {
  const list = asArray(v, what);
  if (list.length > max) refuse(`${what} has more than ${max} entries`);
  if (!list.every(ok)) refuse(`${what} has an entry of the wrong shape`);
  return [...new Set(list as string[])].sort();
}

/** `v` when it is an http or https origin written as URL writes one, else null. */
function httpOrigin(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 200 || !URL.canParse(v)) return null;
  const u = new URL(v);
  return (u.protocol === "https:" || u.protocol === "http:") && u.origin === v ? u.origin : null;
}

/**
 * A venue's publish state, rebuilt field by field so the same state always comes out the
 * same. The secret is the publish contract's shape and nothing else; the origin is an http
 * or https origin, as the page address is saved.
 */
function checkPublish(raw: unknown, what: string): VenuePublish {
  const p = asObject(raw, `${what}'s publish state`);
  if (!isStagePlotsSecret(p.secret)) refuse(`${what}'s publish secret is not one this server makes`);
  const origin = httpOrigin(p.origin);
  if (origin === null) refuse(`${what}'s publish origin must be an http or https origin`);
  let lastError: VenuePublish["lastError"] = null;
  if (p.lastError !== null) {
    const e = asObject(p.lastError, `${what}'s last publish error`);
    lastError = { at: isoInstant(e.at, `${what}'s last publish error time`), message: text(e.message, PUBLISH_ERROR_CHARS, `${what}'s last publish error`) };
  }
  const isHash = (x: unknown) => typeof x === "string" && STAGEPLOT_HASH.test(x);
  return {
    secret: p.secret,
    origin,
    publishedAt: isoInstant(p.publishedAt, `${what}'s publish time`),
    lastError,
    publishedImages: sortedSet(p.publishedImages, STAGEPLOT_LIMITS.backgrounds, isHash, `${what}'s published backgrounds`),
    unpublishedImages: sortedSet(p.unpublishedImages, STAGEPLOT_LIMITS.backgrounds, isHash, `${what}'s backgrounds not yet published`),
    retired: sortedSet(p.retired, PUBLISH_RETIRED_MAX, isStagePlotsSecret, `${what}'s earlier links`),
  };
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
  const venue: Venue = {
    id,
    name: v.name as string,
    kind: v.kind as VenueKind,
    notes: v.notes as string,
    plotIds,
    defaultPlotId: v.defaultPlotId as string | null,
  };
  if (v.publish !== undefined) venue.publish = checkPublish(v.publish, what);
  return venue;
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

// ── Items ────────────────────────────────────────────────────────────────

const L = STAGEPLOT_LIMITS;

/** A finite number within [min, max], or a refusal naming `what`. */
function within(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    refuse(`${what} must be a number from ${shown(min, "up")} to ${shown(max, "down")}`);
  }
  return v;
}

/**
 * A bound as a refusal states it, to a tenth, rounded inward: a plot 666.666…
 * high reads "to 666.6", never "to 666.7", which would read as allowing the
 * very value it refused.
 */
function shown(n: number, way: "up" | "down"): number {
  return (way === "up" ? Math.ceil(n * 10) : Math.floor(n * 10)) / 10;
}

function text(v: unknown, max: number, what: string): string {
  if (typeof v !== "string") refuse(`${what} must be text`);
  if (v.length > max) refuse(`${what} is longer than ${max} characters`);
  return v;
}

function checkPoint(raw: unknown, height: number, what: string): CablePoint {
  if (!Array.isArray(raw) || raw.length !== 2) refuse(`${what} must be an [x, y] pair`);
  return [within(raw[0], 0, PLOT_UNITS_WIDE, `${what}'s x`), within(raw[1], 0, height, `${what}'s y`)];
}

/**
 * One item, rebuilt field by field: a field the item does not have is dropped,
 * and a type's own fields (symbol, textKind, points, dashed) appear only on
 * that type. So the same item always comes out the same, and an unchanged save
 * compares equal to what is stored.
 */
function checkItem(raw: unknown, height: number, what: string): PlotItem {
  const it = asObject(raw, what);
  const id = checkId(it.id, what);
  const named = `${what} "${id}"`;
  if (!ITEM_TYPES.includes(it.type as ItemType)) refuse(`${named}'s type must be one of ${ITEM_TYPES.join(", ")}`);
  const type = it.type as ItemType;
  const cable = type === "cable";
  // A cable's box and turn are derived from its points below, never checked:
  // whatever the client sent for them is replaced.
  const geometry = (key: "x" | "y" | "w" | "h" | "rotation", min: number, max: number, what: string) =>
    cable ? 0 : within(it[key], min, max, `${named}'s ${what}`);
  if (!cable && it.rotation === -180) refuse(`${named}'s rotation must be more than -180 and at most 180 (-180 is 180)`);
  if (it.color !== null && !PATCH_COLORS.includes(it.color as (typeof PATCH_COLORS)[number])) {
    refuse(`${named}'s colour must be one of the patch sheet's ten swatches, or none`);
  }
  const inputs = asArray(it.inputs, `${named}'s inputs`);
  if (inputs.length > L.inputsPerItem) refuse(`${named} has more than ${L.inputsPerItem} inputs`);
  const item: PlotItem = {
    id,
    type,
    x: geometry("x", 0, PLOT_UNITS_WIDE, "x"),
    y: geometry("y", 0, height, "y"),
    w: geometry("w", L.itemMinSize, L.itemMaxSize, "width"),
    h: geometry("h", L.itemMinSize, L.itemMaxSize, "height"),
    rotation: geometry("rotation", -180, 180, "rotation"),
    label: text(it.label, L.labelChars, `${named}'s label`),
    color: it.color as string | null,
    notes: text(it.notes, L.notesChars, `${named}'s notes`),
    inputs: inputs.map((v, j) => text(v, L.inputChars, `${named}'s input ${j + 1}`)),
  };
  if (type === "symbol") {
    if (!SYMBOL_KINDS.includes(it.symbol as SymbolKind)) refuse(`${named}'s symbol must be one of ${SYMBOL_KINDS.join(", ")}`);
    item.symbol = it.symbol as SymbolKind;
  }
  if (type === "text") {
    if (!TEXT_KINDS.includes(it.textKind as TextKind)) refuse(`${named}'s text kind must be one of ${TEXT_KINDS.join(", ")}`);
    item.textKind = it.textKind as TextKind;
  }
  if (cable) {
    const points = asArray(it.points, `${named}'s points`);
    if (points.length < L.cablePointsMin || points.length > L.cablePointsMax) {
      refuse(`${named} must have ${L.cablePointsMin} to ${L.cablePointsMax} points`);
    }
    item.points = points.map((p, j) => checkPoint(p, height, `${named}'s point ${j + 1}`));
    required(it.dashed, "boolean", `${named}'s dashed`);
    item.dashed = it.dashed as boolean;
    // Never the client's box or turn: a cable's are its points' (withCableBox),
    // derived here, before anything is checked against the plot.
    return withCableBox(item);
  }
  return item;
}

/**
 * A plot's items on a plot `height` units high, each rebuilt (checkItem), or a
 * throw naming the first problem. The items route and the restore check both
 * hold items to this.
 */
export function checkItems(raw: unknown, height: number, what: string): PlotItem[] {
  const list = asArray(raw, `${what}'s items`);
  if (list.length > L.itemsPerPlot) refuse(`${what} can have at most ${L.itemsPerPlot} items`);
  const items = list.map((it, j) => checkItem(it, height, `${what}'s item ${j + 1}`));
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) refuse(`${what} lists item "${it.id}" more than once`);
    seen.add(it.id);
  }
  return items;
}

/** Why `items` cannot be saved on a plot `height` units high, or null. The
 *  routes and the restore check use checkItems; this is the test seam, and the
 *  renderer's tests hold the editor's drafts to the server's rules with it. */
export function validateItems(items: unknown, height: number): string | null {
  try {
    checkItems(items, height, "the plot");
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * `items` fitted to a plot `height` units high (fitToHeight, which the editor
 * uses too), with how many moved; the list itself when none did. Used when a
 * plot switches to a background that makes it shorter.
 */
export function itemsWithin(items: readonly PlotItem[], height: number): { items: PlotItem[]; moved: number } {
  let moved = 0;
  const next = items.map((it) => {
    const fitted = fitToHeight(it, height);
    if (fitted !== it) moved++;
    return fitted;
  });
  return moved === 0 ? { items: items as PlotItem[], moved } : { items: next, moved };
}

function checkPlot(raw: unknown, i: number, heightOf: (backgroundId: string | null) => number): Plot {
  const p = asObject(raw, `plot ${i + 1}`);
  const id = checkId(p.id, `plot ${i + 1}`);
  const what = `plot "${id}"`;
  required(p.venueId, "string", `${what}'s venue`);
  orRefuse(nameProblem(p.name, what));
  if (p.backgroundId !== null && typeof p.backgroundId !== "string") refuse(`${what}'s background must be a background id or null`);
  orRefuse(fadeProblem(p.bgFade, what));
  return {
    id,
    venueId: p.venueId as string,
    name: p.name as string,
    backgroundId: p.backgroundId as string | null,
    bgFade: p.bgFade as number,
    items: checkItems(p.items, heightOf(p.backgroundId as string | null), what),
    version: checkCount(p.version, `${what}'s version`),
  };
}

function checkOverride(raw: unknown, i: number): PlotOverride {
  const o = asObject(raw, `override ${i + 1}`);
  const what = typeof o.planId === "string" ? `the override for plan "${o.planId}"` : `override ${i + 1}`;
  const planProblem = planIdProblem(o.planId);
  if (planProblem) refuse(`${what}: ${planProblem}`);
  const venueId = checkId(o.venueId, `${what}'s venue`);
  const plotId = checkId(o.plotId, `${what}'s plot`);
  let planDate: string | null;
  try {
    planDate = planDateOf(o.planDate);
  } catch (err) {
    refuse(`${what}: ${errorMessage(err)}`);
  }
  return { planId: o.planId as string, venueId, plotId, planDate };
}

/** Overrides in their one order: by plan, then venue. */
function sortOverrides(list: PlotOverride[]): PlotOverride[] {
  return [...list].sort((a, b) => a.planId.localeCompare(b.planId) || a.venueId.localeCompare(b.venueId));
}

/**
 * A whole document, every field shaped as a save would leave it and every id
 * it names resolved — or a throw naming the first that is not. The restore
 * check, and the rule the routes' writes keep. A document with no `overrides`
 * (saved before they existed) reads as [].
 */
export function checkStagePlotsDoc(raw: unknown): StagePlotsDoc {
  const d = asObject(raw, "the stage plots");
  const venues = asArray(d.venues, "the venues").map(checkVenue);
  const backgrounds = asArray(d.backgrounds, "the backgrounds").map(checkBackground);
  // A plot naming a background that does not exist is refused below; until
  // then its items are measured on the grid's height.
  const backgroundById = new Map(backgrounds.map((b) => [b.id, b]));
  const heightOf = (id: string | null) => plotHeight(id === null ? null : backgroundById.get(id));
  const plots = asArray(d.plots, "the plots").map((p, i) => checkPlot(p, i, heightOf));
  const overrides = d.overrides === undefined ? [] : asArray(d.overrides, "the overrides").map(checkOverride);
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
  if (overrides.length > STAGEPLOT_LIMITS.overrides) refuse(LIMIT_SAYS.override);
  const seenOverride = new Set<string>();
  for (const o of overrides) {
    const venue = venueById.get(o.venueId);
    if (!venue) refuse(`the override for plan "${o.planId}" names a venue that does not exist`);
    if (!venue.plotIds.includes(o.plotId)) refuse(`the override for plan "${o.planId}" names a plot that is not one of venue "${venue.id}"'s`);
    const key = JSON.stringify([o.planId, o.venueId]);
    if (seenOverride.has(key)) refuse(`plan "${o.planId}" has more than one override for venue "${o.venueId}"`);
    seenOverride.add(key);
  }
  return { venues, backgrounds, plots, overrides: sortOverrides(overrides) };
}

// ── Overrides ────────────────────────────────────────────────────────────

/** A PUT /api/stageplots/overrides body: plotId null removes the override. */
export interface OverrideChange {
  planId: string;
  venueId: string;
  plotId: string | null;
  planDate: string | null;
}

/** The change a PUT /api/stageplots/overrides body asks for, or why it cannot be one. */
export function readOverrideChange(body: unknown): OverrideChange | { problem: string } {
  if (!isRecord(body)) return { problem: "the override must be an object" };
  const planProblem = planIdProblem(body.planId);
  if (planProblem) return { problem: planProblem };
  if (typeof body.venueId !== "string" || body.venueId === "") return { problem: "venueId must be a venue id" };
  if (body.plotId !== null && typeof body.plotId !== "string") return { problem: "plotId must be one of the venue's plots, or null to use the default" };
  try {
    return { planId: body.planId as string, venueId: body.venueId, plotId: body.plotId, planDate: planDateOf(body.planDate) };
  } catch (err) {
    return { problem: errorMessage(err) };
  }
}

/**
 * `change` applied: the new document, or `doc` itself when it changes nothing
 * (the same plot again, or removing an override that is not there), with the
 * venue's name and the plot's (null when handed back to the default) for the
 * log; or a refusal, with the status to answer it with. A change that does not
 * know the plan's date keeps the date already stored. The routes and the
 * editor's tests apply overrides through this one function.
 */
export function applyOverride(
  doc: StagePlotsDoc,
  change: OverrideChange,
): { doc: StagePlotsDoc; venueName: string; plotName: string | null } | { status: 400 | 404; problem: string } {
  const venue = doc.venues.find((v) => v.id === change.venueId);
  if (!venue) return { status: 404, problem: "no such venue" };
  const done = (next: StagePlotsDoc) => ({
    doc: next,
    venueName: venue.name,
    plotName: change.plotId === null ? null : (doc.plots.find((p) => p.id === change.plotId)?.name ?? change.plotId),
  });
  const at = doc.overrides.findIndex((o) => o.planId === change.planId && o.venueId === change.venueId);
  const current = at >= 0 ? doc.overrides[at] : null;
  if (change.plotId === null) {
    return done(current ? { ...doc, overrides: doc.overrides.filter((_, i) => i !== at) } : doc);
  }
  if (!venue.plotIds.includes(change.plotId)) return { status: 400, problem: "plotId must be one of the venue's plots, or null to use the default" };
  const next: PlotOverride = { planId: change.planId, venueId: venue.id, plotId: change.plotId, planDate: change.planDate ?? current?.planDate ?? null };
  if (current && current.plotId === next.plotId && current.planDate === next.planDate) return done(doc);
  if (!current && doc.overrides.length >= STAGEPLOT_LIMITS.overrides) return { status: 400, problem: LIMIT_SAYS.override };
  return done({ ...doc, overrides: current ? doc.overrides.map((o, i) => (i === at ? next : o)) : sortOverrides([...doc.overrides, next]) });
}

/**
 * A document as read from disk, with `overrides` as a list: a file saved
 * before overrides existed has no key for them and reads as []. One whose
 * `overrides` is there but not a list reads as [] too, and says so on
 * [stageplots], since the next save will write the empty list over it.
 */
export function normalizeStagePlots(doc: StagePlotsDoc): StagePlotsDoc {
  if (!isRecord(doc) || Array.isArray(doc.overrides)) return doc;
  if ((doc as { overrides?: unknown }).overrides !== undefined) {
    console.warn("[stageplots] stageplots.json's plan overrides are not a list; read as none, and the next save replaces them");
  }
  return { ...doc, overrides: [] };
}

const store = new DataStore<StagePlotsDoc>("stageplots.json", EMPTY, "config", {
  restoreCheck: checked(checkStagePlotsDoc),
  normalize: normalizeStagePlots,
});

export const stageplotsStore = {
  /** The document. Throws a StoreReadError (503) when the file cannot be read,
   *  rather than answering with no venues. */
  get(): Promise<StagePlotsDoc> {
    return store.loadStrict();
  },
  /** Whether the document is the empty one a damaged stageplots.json was replaced with. */
  get loadedFromCorrupt(): boolean {
    return store.loadedFromCorrupt;
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
