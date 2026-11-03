// boards:changed — tells a Mic slots page which boards changed, however they were
// written.
//
// slots.json is written from more than twenty places (save-all, the per-screen
// slot routes, presets, copy, revert, promote, board create/rename/resize/
// duplicate/delete, view create and import, the daily prune, the boot
// migration). Every one goes through the store, so the store's own after-save
// hook is the one place this is announced: a write path added later cannot
// forget it.
//
// The diff is not gated on subscribers. It is a JSON.stringify per layout of a
// file the write just stringified whole, on a write an operator made, and the
// frame it builds is also what the connect burst re-sends, which must be exact
// for a client that subscribes later.

import { randomUUID } from "node:crypto";

import { broadcast } from "./broadcaster.js";
import { isRecord } from "./is-record.js";
import { BOARDS_CHANGED_CHANNEL, type BoardChange, type BoardsChanged } from "../types/boards-changed.js";

const EPOCH = randomUUID();
let last: BoardsChanged = { epoch: EPOCH, seq: 0, boards: [] };

/** The last frame, for the connect burst. */
export function boardsChangedState(): BoardsChanged {
  return last;
}

/** One board's parts as comparable strings: its metadata and each layout. */
interface BoardParts {
  meta: string | undefined;
  targets: Map<string, string>;
}

/** A serialised slots.json (v3 or v4) by board, or null for any other shape. */
function partsOf(raw: unknown): Map<string, BoardParts> | null {
  if (!isRecord(raw) || !isRecord(raw.defaults) || !isRecord(raw.overrides)) return null;
  const out = new Map<string, BoardParts>();
  const board = (id: string): BoardParts => {
    let p = out.get(id);
    if (!p) out.set(id, (p = { meta: undefined, targets: new Map() }));
    return p;
  };
  if (isRecord(raw.boards)) for (const [id, meta] of Object.entries(raw.boards)) board(id).meta = JSON.stringify(meta);
  for (const [id, byType] of Object.entries(raw.defaults)) {
    if (!isRecord(byType)) continue;
    for (const [type, slots] of Object.entries(byType)) board(id).targets.set(`default:${type}`, JSON.stringify(slots));
  }
  for (const [id, byPlan] of Object.entries(raw.overrides)) {
    if (!isRecord(byPlan)) continue;
    for (const [plan, o] of Object.entries(byPlan)) board(id).targets.set(`plan:${plan}`, JSON.stringify(o));
  }
  return out;
}

/** Every board whose metadata or any layout differs between two files, sorted. */
export function diffSlotsFiles(previous: unknown, next: unknown): BoardChange[] {
  const before = partsOf(previous);
  const after = partsOf(next);
  const none = new Map<string, BoardParts>();
  // A file from before v3 (only the boot migration writes over one) is
  // compared as if it held nothing: every board in the new file changed.
  const a = before ?? none;
  const b = after ?? none;
  const out: BoardChange[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id);
    const y = b.get(id);
    const targets = new Set([...(x?.targets.keys() ?? []), ...(y?.targets.keys() ?? [])]);
    const changed = [...targets].filter((t) => x?.targets.get(t) !== y?.targets.get(t)).sort();
    const meta = x?.meta !== y?.meta;
    if (meta || changed.length > 0) out.push({ id, meta, targets: changed });
  }
  return out.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

/** The store's after-save hook: number the write and say what it changed. */
export function announceSlotsSaved(previous: unknown, next: unknown): void {
  last = { epoch: EPOCH, seq: last.seq + 1, boards: diffSlotsFiles(previous, next) };
  broadcast(BOARDS_CHANGED_CHANNEL, last);
}
