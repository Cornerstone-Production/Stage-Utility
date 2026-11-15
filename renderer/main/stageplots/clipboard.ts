// clipboard.ts — the plot editor's own clipboard: Cut, Copy and Paste of plot items.
//
// Not the system clipboard. Production is plain HTTP, where the browser offers no
// clipboard API, and a plot item means nothing to another app anyway. What is copied
// is kept in this page and in the browser's storage, so a copy pastes into another
// plot, another venue, or the editor open in another tab of the same browser. Storage
// refused (a private window) keeps it for this page only.
//
// Each paste of one copy lands a little further down and right than the last
// (Duplicate's offset), so repeated pastes do not stack. A cut's first paste lands
// where the item was.

import { ITEM_TYPES, STAGEPLOT_LIMITS as L, SYMBOL_KINDS, TEXT_KINDS, type PlotItem } from "@main/types/stageplots";
import { PATCH_COLORS } from "@main/types/patch";

import { readStored, removeStored, writeStored } from "../../lib/safe-storage";
import { uid } from "../../lib/uid";
import { DUPLICATE_OFFSET } from "./editor-state";

export const CLIPBOARD_KEY = "stageplots:clipboard";

interface Clip {
  items: PlotItem[];
  /** Pastes made from this copy so far: the next lands this many offsets on. */
  pastes: number;
}

let held: Clip | null = null;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/**
 * Whether `v` is an item the server would accept on a save (stageplots-store checkItem),
 * short of where it sits: a paste moves it onto the plot it lands on. The browser's storage
 * is anything another tab, an older build or a person left there, and a paste of the wrong
 * shape would put the editor's draft where Save is refused for good. clipboard.test.ts
 * holds this to the server's own check, case by case.
 */
function isClipItem(v: unknown): v is PlotItem {
  if (!isObject(v) || typeof v.id !== "string" || v.id.length === 0) return false;
  if (!ITEM_TYPES.includes(v.type as PlotItem["type"])) return false;
  const cable = v.type === "cable";
  if (![v.x, v.y, v.w, v.h, v.rotation].every(isNumber)) return false;
  if (!cable) {
    const [w, h, rotation] = [v.w as number, v.h as number, v.rotation as number];
    if (w < L.itemMinSize || w > L.itemMaxSize || h < L.itemMinSize || h > L.itemMaxSize) return false;
    if (rotation <= -180 || rotation > 180) return false;
  }
  if (v.color !== null && !PATCH_COLORS.includes(v.color as (typeof PATCH_COLORS)[number])) return false;
  if (!isText(v.label, L.labelChars) || !isText(v.notes, L.notesChars)) return false;
  if (!Array.isArray(v.inputs) || v.inputs.length > L.inputsPerItem || !v.inputs.every((i) => isText(i, L.inputChars))) return false;
  if (v.type === "symbol" && !SYMBOL_KINDS.includes(v.symbol as never)) return false;
  if (v.type === "text" && !TEXT_KINDS.includes(v.textKind as never)) return false;
  if (v.patchLink !== undefined) {
    const link = v.patchLink;
    const idOk = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= L.patchIdChars && ![...id].some((ch) => ch.charCodeAt(0) < 0x20);
    if (v.type !== "conn" || !isObject(link) || !idOk(link.sheetId) || !idOk(link.deviceId) || !isText(link.lastName, L.labelChars)) return false;
    if (link.lastColor !== null && !PATCH_COLORS.includes(link.lastColor as (typeof PATCH_COLORS)[number])) return false;
  }
  if (cable) {
    const pts = v.points;
    if (!Array.isArray(pts) || pts.length < L.cablePointsMin || pts.length > L.cablePointsMax) return false;
    if (!pts.every((p) => Array.isArray(p) && p.length === 2 && isNumber(p[0]) && isNumber(p[1]))) return false;
    if (typeof v.dashed !== "boolean") return false;
  }
  return true;
}

function isClip(v: unknown): v is Clip {
  if (!isObject(v) || !Array.isArray(v.items) || v.items.length > L.itemsPerPlot) return false;
  return typeof v.pastes === "number" && Number.isInteger(v.pastes) && v.pastes >= -1 && v.items.every(isClipItem);
}

function current(): Clip | null {
  const stored = readStored<Clip | null>(
    CLIPBOARD_KEY,
    (raw) => {
      const v: unknown = raw === null ? null : JSON.parse(raw);
      return isClip(v) ? v : null;
    },
    null,
  );
  return stored ?? held;
}

function keep(clip: Clip): void {
  held = clip;
  writeStored(CLIPBOARD_KEY, JSON.stringify(clip));
}

/** Copy items. `cut` makes the first paste land where they were. */
export function copyItems(items: readonly PlotItem[], { cut = false }: { cut?: boolean } = {}): void {
  if (items.length === 0) return;
  keep({ items: structuredClone([...items]), pastes: cut ? -1 : 0 });
}

/** Whether anything is there to paste. */
export function canPaste(): boolean {
  return (current()?.items.length ?? 0) > 0;
}

/**
 * What to paste, each item with a new id, and how far it moves from where it was
 * copied; null when nothing is copied. Counts the paste, so the next lands further on.
 */
export function takePaste(): { items: PlotItem[]; offset: number } | null {
  const clip = current();
  if (!clip || clip.items.length === 0) return null;
  const n = clip.pastes + 1;
  keep({ ...clip, pastes: n });
  return { items: clip.items.map((it) => ({ ...structuredClone(it), id: uid("i") })), offset: n * DUPLICATE_OFFSET };
}

/** For a test: forget what is copied. */
export function clearClipboard(): void {
  held = null;
  removeStored(CLIPBOARD_KEY);
}
