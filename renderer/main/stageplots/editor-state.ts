// editor-state.ts — the plot editor's draft, as a pure reducer: every operation
// on the items, the undo and redo stacks, and what was last saved.
//
// Markup is a draft: nothing reaches /stageplots until Save sends the whole
// item list (stageplotsApi.saveItems). Undo covers the draft only.
//
// A gesture (a drag, a resize, a rotate, a cable point, typing in a field) is
// ONE undo step however many pointermoves or keystrokes it takes: its first
// change remembers the state before it, every later change is applied to the
// item as it was when the gesture began, and commitGesture pushes that one
// remembered state if anything changed. Everything else (add, nudge, delete,
// a swatch) is a step of its own.
//
// Each operation replaces only the item it changes; the others keep their
// identity, so PlotSvg redraws one item of five hundred per pointermove.
// Every changed item goes through fitItem, so the draft is always something
// the server will accept.

import { fitToHeight } from "@main/services/stageplots-doc";
import { PLOT_UNITS_WIDE, type CablePoint, type PatchLink, type PlotItem, type SymbolKind, type TextKind } from "@main/types/stageplots";

import { clampPoint, fitItem, resizeInFrame, round1, snapRotation, withCableBox } from "./geometry";
import { SYMBOLS } from "./symbols";

/** What the palette adds: a type, a kind of text, or a symbol. */
export type AddKind = "box" | "circle" | "zone" | "cable" | "conn" | TextKind | `sym:${SymbolKind}`;

/**
 * Each kind's size when added, in whole plot units: the mockup's sizes on its
 * 2400-wide plot, divided by 2.4 and rounded, so the inspector shows 117 x 104
 * rather than 116.7 x 104.2.
 */
export const DEFAULT_SIZES: Record<Exclude<AddKind, "cable" | `sym:${SymbolKind}`> | SymbolKind, [number, number]> = {
  box: [117, 75],
  circle: [83, 83],
  zone: [217, 133],
  conn: [25, 25],
  label: [158, 25],
  callout: [23, 23],
  dimension: [250, 18],
  drumkit: [117, 104],
  piano: [150, 121],
  keyboard: [125, 46],
  wedge: [58, 33],
  amp: [67, 50],
  micstand: [46, 46],
  console: [150, 58],
  speaker: [46, 67],
  camera: [71, 50],
};

/** A new cable's half-length: it is added as a level line 250 units long. */
const CABLE_HALF = 125;
/** How far Duplicate offsets the copy, right and down. */
export const DUPLICATE_OFFSET = 16;
/** Undo steps kept; the oldest go first. */
const UNDO_LIMIT = 200;

/** One undo step: the items and which was selected. */
export interface Snapshot {
  items: PlotItem[];
  selectedId: string | null;
}

export interface EditorState {
  items: PlotItem[];
  selectedId: string | null;
  undo: Snapshot[];
  redo: Snapshot[];
  /** The items as the server last held them: what Discard returns to. */
  savedItems: PlotItem[];
  /** The plot's height in plot units, which every change is kept inside. */
  height: number;
  /** The state before the gesture under way, or null between gestures. */
  gesture: Snapshot | null;
}

export type EditorAction =
  | { type: "add"; kind: AddKind; at: { x: number; y: number }; id: string }
  | { type: "select"; id: string | null }
  /** Part of a drag: dx, dy is the whole distance since the drag began. */
  | { type: "move"; id: string; dx: number; dy: number }
  /** An arrow key: one step of its own. */
  | { type: "nudge"; id: string; dx: number; dy: number }
  | { type: "resize"; id: string; point: { x: number; y: number }; pad?: number }
  | { type: "rotate"; id: string; angle: number }
  | { type: "movePoint"; id: string; index: number; point: { x: number; y: number } }
  /** A field edit; `live` while typing (one step, committed when it settles). */
  | { type: "patch"; id: string; fields: Partial<Omit<PlotItem, "id" | "type">>; live?: boolean }
  /** Link a connection point to a patch device: it takes the device's name and colour, saved as its last. */
  | { type: "link"; id: string; link: PatchLink }
  /** Unlink it, keeping the name and colour it showed, which are its own again. */
  | { type: "unlink"; id: string; label: string; color: string | null }
  | { type: "addInput"; id: string }
  | { type: "removeInput"; id: string; index: number }
  | { type: "duplicate"; id: string; newId: string }
  | { type: "remove"; id: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "commitGesture" }
  /** A save landed: `items` is what the server stored for the list `sent`. */
  | { type: "saved"; sent: PlotItem[]; items: PlotItem[] }
  | { type: "discard" }
  /** The server's items replace the draft and its history (a reload, or a change from elsewhere to a clean draft). */
  | { type: "load"; items: PlotItem[]; height: number }
  /** The plot's height changed (its background did); later changes are kept inside the new one. */
  | { type: "height"; height: number };

export function initialEditorState(items: PlotItem[], height: number): EditorState {
  return { items, selectedId: null, undo: [], redo: [], savedItems: items, height, gesture: null };
}

/** Whether two item lists hold the same items, cheaply when most are the same objects. */
export function sameItems(a: readonly PlotItem[], b: readonly PlotItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((it, i) => it === b[i] || JSON.stringify(it) === JSON.stringify(b[i]));
}

/** Whether the draft differs from what the server holds. */
export function isDirty(state: EditorState): boolean {
  return !sameItems(state.items, state.savedItems);
}

function snapshot(state: EditorState): Snapshot {
  return { items: state.items, selectedId: state.selectedId };
}

/** `state` with a step pushed: the snapshot goes on the undo stack and redo empties. */
function pushed(state: EditorState, before: Snapshot, next: Partial<EditorState>): EditorState {
  return { ...state, ...next, undo: [...state.undo, before].slice(-UNDO_LIMIT), redo: [], gesture: null };
}

/** The items with item `id` replaced by `make(item)`, fitted to the plot, every
 *  other item the same object as before; null when there is no such item. */
function replaceItem(state: EditorState, id: string, make: (it: PlotItem) => PlotItem): PlotItem[] | null {
  const i = state.items.findIndex((it) => it.id === id);
  if (i < 0) return null;
  const next = fitItem(make(state.items[i]), state.height);
  const items = state.items.slice();
  items[i] = next;
  return items;
}

/** A change that is part of a gesture: remembered as one step, applied live. */
function live(state: EditorState, id: string, make: (current: PlotItem, atStart: PlotItem) => PlotItem): EditorState {
  const gesture = state.gesture ?? snapshot(state);
  const atStart = gesture.items.find((it) => it.id === id);
  if (!atStart) return state;
  const items = replaceItem(state, id, (current) => make(current, atStart));
  return items ? { ...state, items, gesture } : state;
}

/** A change that is a step of its own. */
function step(state: EditorState, items: PlotItem[] | null, selectedId = state.selectedId): EditorState {
  if (!items) return state;
  // Anything half-done is folded into the step before this one.
  const base = state.gesture && !sameItems(state.gesture.items, state.items) ? commit(state) : { ...state, gesture: null };
  return pushed(base, snapshot(base), { items, selectedId });
}

/** One item changed by `make`, as a step of its own. */
function stepItem(state: EditorState, id: string, make: (it: PlotItem) => PlotItem): EditorState {
  return step(state, replaceItem(state, id, make));
}

function commit(state: EditorState): EditorState {
  if (!state.gesture) return state;
  if (sameItems(state.gesture.items, state.items)) return { ...state, gesture: null };
  return pushed(state, state.gesture, {});
}

function newItem(kind: AddKind, at: { x: number; y: number }, id: string): PlotItem {
  const base = { id, rotation: 0, label: "", color: null, notes: "", inputs: [] as string[] };
  if (kind === "cable") {
    const points: CablePoint[] = [
      [at.x - CABLE_HALF, at.y],
      [at.x + CABLE_HALF, at.y],
    ];
    return withCableBox({ ...base, type: "cable", x: 0, y: 0, w: 0, h: 0, points, dashed: true });
  }
  const symbol = kind.startsWith("sym:") ? (kind.slice(4) as SymbolKind) : null;
  const [w, h] = DEFAULT_SIZES[symbol ?? (kind as Exclude<AddKind, "cable" | `sym:${SymbolKind}`>)];
  const box = { ...base, x: round1(at.x - w / 2), y: round1(at.y - h / 2), w, h };
  if (symbol) return { ...box, type: "symbol", symbol, label: SYMBOLS[symbol].name };
  if (kind === "label" || kind === "callout" || kind === "dimension") {
    return { ...box, type: "text", textKind: kind, label: kind === "label" ? "Text" : kind === "dimension" ? "10 ft" : "Note" };
  }
  return { ...box, type: kind as "box" | "circle" | "zone" | "conn" };
}

/** Fields set from the inspector. A width or height keeps the centre; a new
 *  text kind takes that kind's size. */
function patched(it: PlotItem, fields: Partial<Omit<PlotItem, "id" | "type">>): PlotItem {
  let next: PlotItem = { ...it, ...fields };
  if (fields.textKind && fields.textKind !== it.textKind) {
    const [w, h] = DEFAULT_SIZES[fields.textKind];
    next = { ...next, h, w: fields.textKind === "callout" ? w : it.w };
  }
  if (next.w !== it.w || next.h !== it.h) {
    const [cx, cy] = [it.x + it.w / 2, it.y + it.h / 2];
    next = { ...next, x: cx - next.w / 2, y: cy - next.h / 2 };
  }
  return next;
}

function moved(it: PlotItem, dx: number, dy: number, height: number): PlotItem {
  if (it.type === "cable" && it.points) {
    // The whole cable moves as far as its furthest point can.
    const xs = it.points.map((p) => p[0]);
    const ys = it.points.map((p) => p[1]);
    const ddx = Math.min(Math.max(dx, -Math.min(...xs)), PLOT_UNITS_WIDE - Math.max(...xs));
    const ddy = Math.min(Math.max(dy, -Math.min(...ys)), height - Math.max(...ys));
    // Rounding and holding each point inside is fitItem's, which every change goes through.
    return { ...it, points: it.points.map(([x, y]): CablePoint => [x + ddx, y + ddy]) };
  }
  return { ...it, x: it.x + dx, y: it.y + dy };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "add": {
      const it = fitItem(newItem(action.kind, action.at, action.id), state.height);
      return step(state, [...state.items, it], it.id);
    }
    case "select":
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
    case "move":
      return live(state, action.id, (_, start) => moved(start, action.dx, action.dy, state.height));
    case "nudge":
      return stepItem(state, action.id, (it) => moved(it, action.dx, action.dy, state.height));
    case "resize":
      return live(state, action.id, (_, start) => (start.type === "cable" ? start : { ...start, ...resizeInFrame(start, action.point, action.pad) }));
    case "rotate":
      return live(state, action.id, (current) => (current.type === "cable" ? current : { ...current, rotation: snapRotation(action.angle) }));
    case "movePoint":
      return live(state, action.id, (current) => {
        if (!current.points || action.index < 0 || action.index >= current.points.length) return current;
        const points = current.points.slice();
        points[action.index] = clampPoint(action.point, state.height);
        return { ...current, points };
      });
    case "patch":
      if (action.live) return live(state, action.id, (current) => patched(current, action.fields));
      return stepItem(state, action.id, (it) => patched(it, action.fields));
    case "link":
      return stepItem(state, action.id, (it) =>
        it.type === "conn" ? { ...it, label: action.link.lastName, color: action.link.lastColor, patchLink: action.link } : it,
      );
    case "unlink":
      return stepItem(state, action.id, (it) => {
        if (!it.patchLink) return it;
        const { patchLink: _link, ...rest } = it;
        return { ...rest, label: action.label, color: action.color };
      });
    case "addInput":
      return stepItem(state, action.id, (it) => ({ ...it, inputs: [...it.inputs, ""] }));
    case "removeInput":
      return stepItem(state, action.id, (it) => ({ ...it, inputs: it.inputs.filter((_, i) => i !== action.index) }));
    case "duplicate": {
      const source = state.items.find((it) => it.id === action.id);
      if (!source) return state;
      const copy = fitItem(
        moved({ ...structuredClone(source), id: action.newId }, DUPLICATE_OFFSET, DUPLICATE_OFFSET, state.height),
        state.height,
      );
      return step(state, [...state.items, copy], copy.id);
    }
    case "remove":
      return step(
        state,
        state.items.filter((it) => it.id !== action.id),
        state.selectedId === action.id ? null : state.selectedId,
      );
    case "commitGesture":
      return commit(state);
    case "undo": {
      const s = commit(state);
      const prev = s.undo.at(-1);
      if (!prev) return s;
      return { ...s, ...restore(prev), undo: s.undo.slice(0, -1), redo: [...s.redo, snapshot(s)] };
    }
    case "redo": {
      const s = commit(state);
      const next = s.redo.at(-1);
      if (!next) return s;
      return { ...s, ...restore(next), redo: s.redo.slice(0, -1), undo: [...s.undo, snapshot(s)] };
    }
    case "saved":
      return { ...state, savedItems: action.items, items: state.items === action.sent ? action.items : state.items };
    case "discard":
      return {
        ...state,
        items: state.savedItems,
        undo: [],
        redo: [],
        gesture: null,
        selectedId: state.savedItems.some((it) => it.id === state.selectedId) ? state.selectedId : null,
      };
    case "height": {
      if (state.height === action.height) return state;
      // Fitted by the server's own rule (fitToHeight), so nothing can come back
      // below the new edge: every undo and redo step always, and the draft under
      // unsaved work (a background changed elsewhere), so a Save reaches the
      // version check rather than being refused for an item's y. A clean draft
      // is replaced by the server's items instead.
      const fit = (items: PlotItem[]) => {
        const next = items.map((it) => fitToHeight(it, action.height));
        return next.every((it, i) => it === items[i]) ? items : next;
      };
      const snap = (s: Snapshot) => {
        const items = fit(s.items);
        return items === s.items ? s : { ...s, items };
      };
      return {
        ...state,
        height: action.height,
        items: isDirty(state) ? fit(state.items) : state.items,
        undo: state.undo.map(snap),
        redo: state.redo.map(snap),
        gesture: state.gesture && snap(state.gesture),
      };
    }
    case "load":
      return {
        ...initialEditorState(action.items, action.height),
        selectedId: action.items.some((it) => it.id === state.selectedId) ? state.selectedId : null,
      };
  }
}

/** A snapshot put back, its selection dropped if that item is not in it. */
function restore(s: Snapshot): Pick<EditorState, "items" | "selectedId"> {
  return { items: s.items, selectedId: s.items.some((it) => it.id === s.selectedId) ? s.selectedId : null };
}
