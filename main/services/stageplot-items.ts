// stageplot-items.ts — a stage plot's items held to the rules a save is: the one check.
//
// Pure (no store, no Node), so the routes, the restore check, the drafts store and the editor's
// clipboard (renderer/main/stageplots/clipboard.ts) all hold an item to the same rules, and a
// copy the server would refuse never reaches a paste.

import { ITEM_TYPES, PLOT_UNITS_WIDE, STAGEPLOT_LIMITS, SYMBOL_KINDS, TEXT_KINDS, type CablePoint, type ItemType, type PatchLink, type PlotItem, type SymbolKind, type TextKind } from "../types/stageplots.js";
import { PATCH_COLORS } from "../types/patch.js";
import { errorMessage } from "./errors.js";
import { asArray, asObject, refuse, required } from "./restore-check.js";
import { withCableBox } from "./stageplots-doc.js";
import { STAGEPLOTS_ID } from "../types/servicecue-publish.js";

/** A stage plots id, as every one in stageplots.json is. */
export function checkId(v: unknown, what: string): string {
  if (typeof v !== "string" || !STAGEPLOTS_ID.test(v)) refuse(`${what}'s id must be 1 to 80 letters, digits, - or _`);
  return v;
}

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

/** Text at most `max` characters long, or a refusal naming `what`. */
export function text(v: unknown, max: number, what: string): string {
  if (typeof v !== "string") refuse(`${what} must be text`);
  if (v.length > max) refuse(`${what} is longer than ${max} characters`);
  return v;
}

function checkPoint(raw: unknown, height: number, what: string): CablePoint {
  if (!Array.isArray(raw) || raw.length !== 2) refuse(`${what} must be an [x, y] pair`);
  return [within(raw[0], 0, PLOT_UNITS_WIDE, `${what}'s x`), within(raw[1], 0, height, `${what}'s y`)];
}

/** A text id from the patch sheet: never checked against the patch, which may change under it. */
function patchId(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > L.patchIdChars || [...v].some((ch) => ch.charCodeAt(0) < 0x20)) {
    refuse(`${what} must be 1 to ${L.patchIdChars} characters, none of them a control character`);
  }
  return v;
}

/**
 * A connection point's patch link, rebuilt. Held only to its own shape: a link to a device
 * the patch no longer has still saves, and reads "unlinked" with its last name and colour.
 */
function checkPatchLink(raw: unknown, named: string): PatchLink {
  const link = asObject(raw, `${named}'s patch link`);
  const lastColor = link.lastColor;
  if (lastColor !== null && !PATCH_COLORS.includes(lastColor as (typeof PATCH_COLORS)[number])) {
    refuse(`${named}'s patch link's last colour must be one of the patch sheet's ten swatches, or none`);
  }
  return {
    sheetId: patchId(link.sheetId, `${named}'s patch sheet id`),
    deviceId: patchId(link.deviceId, `${named}'s patch device id`),
    lastName: text(link.lastName, L.labelChars, `${named}'s patch link's last name`),
    lastColor: lastColor as string | null,
  };
}

/**
 * One item, rebuilt field by field: a field the item does not have is dropped,
 * and a type's own fields (symbol, textKind, points, dashed, patchLink) appear only on
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
  if (it.patchLink !== undefined) {
    if (type !== "conn") refuse(`${named} is not a connection point, so it cannot link to a patch device`);
    item.patchLink = checkPatchLink(it.patchLink, named);
  }
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
