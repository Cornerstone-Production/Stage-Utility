// slot-boards.ts — which board a screen or widget shows, and the v3 → v4 move.
//
// Pure: no store, no clock, no log. The controller reads slots.json and
// views.json, hands both here, and writes what comes back; import does the same
// with a bundle's views and slots. One function decides the shape, so a file
// migrated at boot and a bundle migrated on import cannot come out different.
//
// The pointer helpers read BOTH shapes. A boot whose migration could not be
// saved runs on the v3 files as they are, and a v3 key is the board id the
// migration would give it — a view's board is its own id, an inline grid's is
// its object id, a "view" grid's is the view it embeds. So the screens resolve
// the same rows either way.

import type { LayoutObject, LayoutObjectConfig, Slot, SlotBoardMeta, SlotsLayout, View } from "../types/stage.js";
import type { SlotsFile, SlotsOverride } from "./slots-store.js";

type GridConfig = Extract<LayoutObjectConfig, { type: "slots-grid" }>;

/** Fields a grid carried before boards. Their presence is what marks a config
 *  as written by something that does not know about boards. */
const LEGACY_GRID_KEYS = ["source", "sourceViewId", "slotsLayout"] as const;

export function hasLegacyGridFields(c: GridConfig): boolean {
  return LEGACY_GRID_KEYS.some((k) => k in c);
}

/** Walk an object tree, parent before children. */
function walk(objects: readonly LayoutObject[], visit: (o: LayoutObject) => void): void {
  for (const o of objects) {
    visit(o);
    if (o.children?.length) walk(o.children, visit);
  }
}

/**
 * Every slots widget on every CUSTOM view's layout, with its config and the view
 * that holds it. Only a custom view draws its layout, so only those are shown;
 * a layout kept dormant on a view of another kind is not.
 */
export function forEachSlotsGrid(
  views: readonly View[],
  cb: (objectId: string, config: GridConfig, view: View) => void,
): void {
  for (const v of views) {
    if (v.kind !== "custom" || !v.layout) continue;
    walk(v.layout.objects, (o) => {
      if (o.config.type === "slots-grid") cb(o.id, o.config, v);
    });
  }
}

/** The board a slots-kind view shows. A view saved before boards shows the
 *  board its own id names — the v3 key its slots were stored under. */
export function viewBoardId(view: View): string | null {
  if (view.boardId === null) return null;
  if (typeof view.boardId === "string" && view.boardId) return view.boardId;
  return view.kind === "slots" ? view.id : null;
}

/** The board a slots widget shows, or null for none. Reads a config from before
 *  boards the way the migration would point it. */
export function gridBoardId(config: GridConfig, objectId: string): string | null {
  if (!hasLegacyGridFields(config)) return typeof config.boardId === "string" && config.boardId ? config.boardId : null;
  if (typeof config.boardId === "string" && config.boardId) return config.boardId;
  if (config.source === "inline") return objectId;
  return typeof config.sourceViewId === "string" && config.sourceViewId ? config.sourceViewId : null;
}

/** A widget's own display width, from either shape. */
export function gridDisplayWidthIn(config: GridConfig): number | null {
  if (typeof config.displayWidthIn === "number") return positiveOrNull(config.displayWidthIn);
  return positiveOrNull(config.slotsLayout?.displayWidthIn);
}

export function positiveOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Alignment as a screen draws it: both halves, or none. */
export function effectiveSlotsLayout(displayWidthIn: number | null, columnWidthIn: number | null): SlotsLayout | null {
  return displayWidthIn !== null && columnWidthIn !== null ? { displayWidthIn, columnWidthIn } : null;
}

// ── v3 → v4 ────────────────────────────────────────────────────────────────

export interface BoardMigration {
  views: View[];
  file: SlotsFile;
  /** True when either file differs from what was read. */
  changed: boolean;
  /** One line per decision worth an operator's attention, untagged. */
  log: string[];
}

/** Where something points, gathered in one walk. */
interface Pointer {
  kind: "view" | "object";
  id: string;
  /** The view itself, or the view whose layout holds the widget. */
  view: View;
  boardId: string | null;
  /** A grid that stored its own slots under its object id (v3 "inline"). */
  ownKey: boolean;
}

/**
 * A slot as a layout, without what is not layout: its id, and what the resolver
 * fills in on every read. A static slot keeps its own displayName and photo, so
 * those count there.
 */
function layoutOf(slot: Slot): Record<string, unknown> {
  const { id: _id, device: _device, ...rest } = slot as Slot & Record<string, unknown>;
  const kind = slot.link?.kind;
  if (kind !== "static") {
    delete rest.displayName;
    delete rest.photoUrl;
    delete rest.shownPositions;
  }
  return rest;
}

/** JSON with every object's keys sorted, so key order is not a difference. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (!val || typeof val !== "object" || Array.isArray(val)) return val;
    return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** Everything that makes a board what it is, comparable. Null for a board with
 *  no layouts at all: two empty boards are two screens nobody has built yet,
 *  not one board. */
function boardSignature(file: SlotsFile, id: string, columnWidthIn: number | null): string | null {
  const defaults = file.defaults.get(id);
  const overrides = file.overrides.get(id);
  if (!defaults?.size && !overrides?.size) return null;
  return canonical({
    columnWidthIn,
    defaults: [...(defaults ?? [])].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, slots]) => [t, slots.map(layoutOf)]),
    overrides: [...(overrides ?? [])]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([p, o]: [string, SlotsOverride]) => [p, o.serviceTypeId, o.sortDate ?? null, o.slots.map(layoutOf)]),
  });
}

function cloneObjects(objects: readonly LayoutObject[]): LayoutObject[] {
  return objects.map((o) => ({ ...o, config: { ...o.config }, ...(o.children ? { children: cloneObjects(o.children) } : {}) }));
}

/**
 * Move slots.json and the views onto named boards. Idempotent: run over its own
 * output it changes nothing, so it runs on every boot and finishes whatever an
 * interrupted run, a restored backup or an editor from before boards left.
 *
 * 1. One board per key, keeping the key as its id, so no slot data moves.
 * 2. Pointers: a slots view → its own id; an inline grid → its object id; a
 *    "view" grid → the board of the view it embedded.
 * 3. A view's or inline grid's column width moves onto its board; display
 *    widths stay where they were. A "view" grid takes the embedded view's
 *    display width, which is the one it was drawn with.
 * 4. Boards made in THIS run collapse when identical in every layout and in
 *    column width, slot ids aside. A screen's board survives over a widget's,
 *    then the lowest id; every pointer moves
 *    to it, and the other's entries go. A board made before is never merged:
 *    two identical boards an operator kept are two boards.
 * 5. A key nothing points at is kept, named "Unused board N".
 */
export function migrateBoards(views: readonly View[], input: SlotsFile, now: string): BoardMigration {
  const log: string[] = [];
  const file: SlotsFile = {
    version: 4,
    boards: new Map([...input.boards].map(([id, b]) => [id, { ...b }])),
    defaults: new Map(input.defaults),
    overrides: new Map(input.overrides),
  };
  const viewsById = new Map(views.map((v) => [v.id, v]));
  const liftedWidth = new Map<string, number>();
  const pointers: Pointer[] = [];
  let viewsChanged = false;

  // Views first: a "view" grid points at the board its source view ends up on.
  const pointedViews = views.map((v): View => {
    if (v.kind !== "slots") return v;
    const boardId = viewBoardId(v);
    let next: View = v;
    if (boardId !== null && v.boardId !== boardId) next = { ...next, boardId };
    const legacy = v.slotsLayout;
    if (legacy && "columnWidthIn" in legacy) {
      const cw = positiveOrNull(legacy.columnWidthIn);
      if (cw !== null && boardId !== null) liftedWidth.set(boardId, cw);
      const dw = positiveOrNull(legacy.displayWidthIn);
      next = { ...next, slotsLayout: dw !== null ? { displayWidthIn: dw } : null };
    }
    if (next !== v) viewsChanged = true;
    pointers.push({ kind: "view", id: v.id, view: next, boardId, ownKey: false });
    return next;
  });
  const pointedById = new Map(pointedViews.map((v) => [v.id, v]));

  // Grids, on every layout including a dormant one: a view switched back to
  // custom later must find its grids already pointed.
  const out = pointedViews.map((v): View => {
    if (!v.layout) return v;
    const objects = cloneObjects(v.layout.objects);
    let touched = false;
    walk(objects, (o) => {
      if (o.config.type !== "slots-grid") return;
      const c = o.config;
      const legacy = hasLegacyGridFields(c);
      let boardId: string | null;
      let displayWidthIn: number | null;
      let ownKey = false;
      if (!legacy) {
        boardId = gridBoardId(c, o.id);
        displayWidthIn = gridDisplayWidthIn(c);
      } else if (typeof c.boardId === "string" && c.boardId) {
        boardId = c.boardId;
        displayWidthIn = gridDisplayWidthIn(c);
      } else if (c.source === "inline") {
        boardId = o.id;
        ownKey = true;
        displayWidthIn = positiveOrNull(c.slotsLayout?.displayWidthIn);
        const cw = positiveOrNull(c.slotsLayout?.columnWidthIn);
        if (cw !== null) liftedWidth.set(o.id, cw);
      } else {
        const srcId = typeof c.sourceViewId === "string" ? c.sourceViewId : "";
        const src = srcId ? pointedById.get(srcId) : undefined;
        boardId =
          src && src.kind === "slots" ? viewBoardId(src)
          : srcId && (file.defaults.has(srcId) || file.overrides.has(srcId) || file.boards.has(srcId)) ? srcId
          : null;
        const srcLayout = srcId ? viewsById.get(srcId)?.slotsLayout : undefined;
        displayWidthIn = positiveOrNull(srcLayout?.displayWidthIn);
      }
      if (legacy || c.boardId === undefined) {
        const { source: _s, sourceViewId: _v, slotsLayout: _l, displayWidthIn: _d, ...rest } = c;
        o.config = { ...rest, boardId, ...(displayWidthIn !== null ? { displayWidthIn } : {}) };
        touched = true;
      }
      pointers.push({ kind: "object", id: o.id, view: v, boardId, ownKey });
    });
    if (!touched) return v;
    viewsChanged = true;
    return { ...v, layout: { ...v.layout, objects } };
  });

  // Boards for every key and every pointer target that has none.
  const created = new Set<string>();
  const candidates = new Set<string>([
    ...file.defaults.keys(),
    ...file.overrides.keys(),
    ...pointers.map((p) => p.boardId).filter((id): id is string => !!id),
  ]);
  // A widget is named after its view, with a counter only where one view holds several.
  const ownKeyGrids = new Map<string, Pointer[]>();
  for (const p of pointers) {
    if (!p.ownKey) continue;
    const list = ownKeyGrids.get(p.view.id) ?? [];
    list.push(p);
    ownKeyGrids.set(p.view.id, list);
  }
  const unnamed: string[] = [];
  for (const id of candidates) {
    if (file.boards.has(id)) continue;
    const view = pointedById.get(id);
    const grid = pointers.find((p) => p.kind === "object" && p.ownKey && p.id === id);
    let name: string | null = null;
    if (view) name = view.name;
    else if (grid) {
      const siblings = ownKeyGrids.get(grid.view.id) ?? [grid];
      name = siblings.length > 1 ? `${grid.view.name} · widget ${siblings.indexOf(grid) + 1}` : `${grid.view.name} · widget`;
    } else unnamed.push(id);
    file.boards.set(id, { name: name ?? id, columnWidthIn: liftedWidth.get(id) ?? null, createdAt: now });
    created.add(id);
  }
  // A width lifted onto a board that already existed: the view or grid that
  // still carried it was written by something from before boards, after them.
  for (const [id, cw] of liftedWidth) {
    const b = file.boards.get(id);
    if (b && !created.has(id) && b.columnWidthIn !== cw) file.boards.set(id, { ...b, columnWidthIn: cw });
  }

  // Collapse identical boards made in this run.
  // A screen's board survives over a widget's, so a merged board keeps the
  // screen's name ("Left Display"), then the lowest id breaks ties.
  const viewIds = new Set(views.map((v) => v.id));
  const survivorOrder = (a: string, b: string): number =>
    Number(!viewIds.has(a)) - Number(!viewIds.has(b)) || (a < b ? -1 : a > b ? 1 : 0);
  const bySignature = new Map<string, string[]>();
  for (const id of [...created].sort(survivorOrder)) {
    const sig = boardSignature(file, id, file.boards.get(id)?.columnWidthIn ?? null);
    if (sig === null) continue;
    const group = bySignature.get(sig) ?? [];
    group.push(id);
    bySignature.set(sig, group);
  }
  const mergedInto = new Map<string, string>();
  let merged = 0;
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    const [survivor, ...losers] = group as [string, ...string[]];
    for (const loser of losers) {
      mergedInto.set(loser, survivor);
      log.push(`merged board "${file.boards.get(loser)?.name ?? loser}" (${loser}) into "${file.boards.get(survivor)?.name ?? survivor}" (${survivor}) (identical layouts)`);
      file.boards.delete(loser);
      file.defaults.delete(loser);
      file.overrides.delete(loser);
      created.delete(loser);
      merged++;
    }
  }
  const repoint = (id: string | null): string | null => (id !== null ? (mergedInto.get(id) ?? id) : null);
  for (const p of pointers) p.boardId = repoint(p.boardId);
  const finalViews =
    mergedInto.size === 0
      ? out
      : out.map((v): View => {
          let next = v;
          if (v.boardId && mergedInto.has(v.boardId)) next = { ...next, boardId: repoint(v.boardId) as string };
          if (next.layout) {
            const objects = cloneObjects(next.layout.objects);
            let touched = false;
            walk(objects, (o) => {
              if (o.config.type !== "slots-grid") return;
              const b = o.config.boardId;
              if (typeof b === "string" && mergedInto.has(b)) {
                o.config = { ...o.config, boardId: repoint(b) };
                touched = true;
              }
            });
            if (touched) next = { ...next, layout: { ...next.layout, objects } };
          }
          return next;
        });

  // Unused: made in this run and shown nowhere.
  const pointed = new Set(pointers.map((p) => p.boardId).filter((id): id is string => !!id));
  let unusedN = 0;
  let unnamedN = 0;
  for (const id of [...created].sort()) {
    if (pointed.has(id)) continue;
    unusedN++;
    const meta = file.boards.get(id) as SlotBoardMeta;
    if (unnamed.includes(id)) file.boards.set(id, { ...meta, name: `Unused board ${++unnamedN}` });
    log.push(`kept unused board "${file.boards.get(id)?.name}" (${id}): no screen or widget shows it`);
  }

  if (input.version === 3) {
    log.unshift(
      `migrated slots.json v3 → v4: ${file.boards.size} board(s) from ${candidates.size} key(s), ${merged} merged, ${unusedN} unused`,
    );
  } else if (created.size > 0) {
    log.unshift(`added ${created.size} board(s) for slots nothing had a board for`);
  }

  const boardsChanged =
    input.version !== 4 ||
    created.size > 0 ||
    merged > 0 ||
    [...file.boards].some(([id, b]) => input.boards.get(id)?.columnWidthIn !== b.columnWidthIn);
  return { views: finalViews, file, changed: viewsChanged || boardsChanged, log };
}
