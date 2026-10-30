// The Mic slots page's arrangement model: what dragging, stacking and the
// keyboard do to a set of boards.
//
// Pure. A board is a slot list; its COLUMNS are derived from it by the kiosk's own
// rule (groupColumns), edited as lists of slots, and written back with `order` and
// `stackWithPrevious` set. Nothing here knows about React or dnd-kit, so every
// move is tested as a function and the page only has to say which move it means.
//
// Every operation returns the SAME `Boards` object when it changes nothing. The
// page marks a board unsaved only when a move returned a layout that differs, so a
// drop back where a card already was does not light "Unsaved changes".
//
// The rules are the approved mockup's (EditorBoard.dc.html): a gap makes a column,
// a card's lower half stacks below it, a column's bar moves the whole stack,
// spacers move like a column and never stack, and every board on the page is a
// target for every one of those.

import { groupColumns } from "../../components/slots-columns";

/** Slot lists by board id. */
export type Boards = Record<string, Slot[]>;

/** A column of slots, lead first; a spacer is a column of one spacer slot. */
export type Item = Slot[];

export type Drag =
  /** One card. Dropped in a gap it leaves its stack and becomes its own column. */
  | { kind: "slot"; id: string }
  /** A whole column (or a spacer), named by its lead slot. */
  | { kind: "column"; id: string };

export type Drop =
  | { kind: "gap"; boardId: string; index: number }
  /** The lower half of a card: stack below it. */
  | { kind: "stack"; targetId: string };

export const isSpacer = (s: Slot): boolean => s.link.kind === "spacer";
export const isSpacerItem = (item: Item): boolean => item.length > 0 && item.every(isSpacer);

/** The columns of a slot list, in order. */
export function itemsOf(slots: readonly Slot[]): Item[] {
  return groupColumns(slots);
}

/** Back to a slot list: `order` is the position, and every slot after a column's
 *  lead is stacked on the one before it. */
export function slotsOf(items: readonly Item[]): Slot[] {
  const out: Slot[] = [];
  for (const item of items) {
    item.forEach((slot, i) => {
      const { stackWithPrevious: _drop, ...rest } = slot;
      out.push({ ...rest, order: out.length, ...(i > 0 ? { stackWithPrevious: true } : {}) });
    });
  }
  return out;
}

type ItemBoards = Record<string, Item[]>;

function toItems(boards: Boards): ItemBoards {
  const out: ItemBoards = {};
  for (const [id, slots] of Object.entries(boards)) out[id] = itemsOf(slots).map((c) => [...c]);
  return out;
}

/** The result of an edit, with every board that did not change keeping its list
 *  (and the whole `Boards` object when no board changed). */
function fromItems(before: Boards, items: ItemBoards): Boards {
  const out: Boards = {};
  let changed = false;
  for (const [id, cols] of Object.entries(items)) {
    const was = before[id] ?? [];
    const wasCols = itemsOf(was);
    // What is drawn, by slot id: `slotsOf` rewrites order and flags, so comparing
    // the lists themselves would call every move a change.
    const same =
      wasCols.length === cols.length &&
      wasCols.every((c, i) => c.length === cols[i]!.length && c.every((s, j) => s.id === cols[i]![j]!.id));
    out[id] = same ? was : slotsOf(cols);
    if (!same) changed = true;
  }
  return changed ? out : before;
}

export interface Place {
  boardId: string;
  /** Index of the column in the board. */
  index: number;
  /** Position inside the column; 0 is the lead. */
  pos: number;
}

export function locate(boards: Boards, slotId: string): Place | null {
  for (const [boardId, slots] of Object.entries(boards)) {
    const cols = itemsOf(slots);
    for (let index = 0; index < cols.length; index++) {
      const pos = cols[index]!.findIndex((s) => s.id === slotId);
      if (pos >= 0) return { boardId, index, pos };
    }
  }
  return null;
}

export function findSlot(boards: Boards, slotId: string): Slot | null {
  for (const slots of Object.values(boards)) {
    const s = slots.find((x) => x.id === slotId);
    if (s) return s;
  }
  return null;
}

/** Take `drag` out of every board; what was taken, and whether the lists changed. */
function take(items: ItemBoards, drag: Drag): Item | null {
  let moving: Item | null = null;
  for (const id of Object.keys(items)) {
    items[id] = items[id]!
      .map((item) => {
        if (moving) return item;
        if (drag.kind === "column" && item[0]?.id === drag.id) {
          moving = item;
          return null;
        }
        if (drag.kind === "slot" && item.some((s) => s.id === drag.id)) {
          moving = [item.find((s) => s.id === drag.id)!];
          const rest = item.filter((s) => s.id !== drag.id);
          return rest.length > 0 ? rest : null;
        }
        return item;
      })
      .filter((item): item is Item => item !== null);
  }
  return moving;
}

/**
 * Drop `drag` into a gap: the card becomes its own column there (a card dragged
 * out of a stack unstacks), or the whole column lands there.
 *
 * `index` is a gap in the board as it is BEFORE the move, so dragging a column one
 * place right is a drop in the gap after its neighbour, as it looks on screen.
 */
export function moveToGap(boards: Boards, drag: Drag, to: { boardId: string; index: number }): Boards {
  const items = toItems(boards);
  const target = items[to.boardId];
  if (!target) return boards;
  // A marker stands for the gap while the dragged thing is taken out, so removing
  // it from before the gap cannot shift the landing place.
  const MARK: Item = [];
  target.splice(Math.max(0, Math.min(to.index, target.length)), 0, MARK);
  const moving = take(items, drag);
  if (!moving) return boards;
  items[to.boardId] = items[to.boardId]!.map((item) => (item === MARK ? moving : item));
  return fromItems(boards, items);
}

/**
 * Drop `drag` on the lower half of a card: it stacks directly below that card, in
 * that card's column. A whole column dropped there joins the stack as a block.
 *
 * A spacer never stacks, and nothing stacks onto itself or its own column.
 */
export function stackOnto(boards: Boards, drag: Drag, targetId: string): Boards {
  // A column is named by its lead slot, so both kinds of drag name a slot.
  const dragged = findSlot(boards, drag.id);
  const target = findSlot(boards, targetId);
  if (!dragged || !target) return boards;
  // A spacer is a gap, not a person: it cannot stack, and nothing stacks onto it.
  if (isSpacer(dragged) || isSpacer(target)) return boards;
  if (drag.kind === "slot" && drag.id === targetId) return boards;

  const items = toItems(boards);
  if (drag.kind === "column") {
    const own = Object.values(items).flat().find((it) => it[0]?.id === drag.id);
    // Onto a card of its own column: nothing to join.
    if (!own || own.some((s) => s.id === targetId)) return boards;
    if (isSpacerItem(own)) return boards;
  }
  const moving = take(items, drag);
  if (!moving) return boards;
  for (const id of Object.keys(items)) {
    items[id] = items[id]!.map((item) => {
      const at = item.findIndex((s) => s.id === targetId);
      return at < 0 ? item : [...item.slice(0, at + 1), ...moving, ...item.slice(at + 1)];
    });
  }
  return fromItems(boards, items);
}

/** Take a card out of its stack into a column of its own, just after it. A card
 *  that is already a column's lead has nothing to leave. */
export function unstack(boards: Boards, slotId: string): Boards {
  const at = locate(boards, slotId);
  if (!at || at.pos === 0) return boards;
  const items = toItems(boards);
  const cols = items[at.boardId]!;
  const col = cols[at.index]!;
  const slot = col[at.pos]!;
  cols[at.index] = col.filter((s) => s.id !== slotId);
  cols.splice(at.index + 1, 0, [slot]);
  return fromItems(boards, items);
}

/** Stack a column's lead card below the nearest column on its left, skipping
 *  spacers. Nothing to join (the first column, or only spacers before it) does
 *  nothing. The card's own followers keep a column of their own. */
export function stackIntoPrevious(boards: Boards, slotId: string): Boards {
  const at = locate(boards, slotId);
  if (!at || at.pos !== 0) return boards;
  const items = toItems(boards);
  const cols = items[at.boardId]!;
  const col = cols[at.index]!;
  if (isSpacerItem(col)) return boards;
  let j = at.index - 1;
  while (j >= 0 && isSpacerItem(cols[j]!)) j--;
  if (j < 0) return boards;
  const rest = col.slice(1);
  cols[j] = [...cols[j]!, col[0]!];
  if (rest.length > 0) cols[at.index] = rest;
  else cols.splice(at.index, 1);
  return fromItems(boards, items);
}

/** The inspector's Stacked switch: off when stacked, on when it can be. */
export function toggleStacked(boards: Boards, slotId: string): Boards {
  const at = locate(boards, slotId);
  if (!at) return boards;
  return at.pos > 0 ? unstack(boards, slotId) : stackIntoPrevious(boards, slotId);
}

/** Is the card stacked, and could it be? Drives the inspector's switch. */
export function stackState(boards: Boards, slotId: string): { stacked: boolean; canStack: boolean } {
  const at = locate(boards, slotId);
  if (!at) return { stacked: false, canStack: false };
  if (at.pos > 0) return { stacked: true, canStack: true };
  const cols = itemsOf(boards[at.boardId]!);
  if (isSpacerItem(cols[at.index]!)) return { stacked: false, canStack: false };
  return { stacked: false, canStack: cols.slice(0, at.index).some((c) => !isSpacerItem(c)) };
}

/** Remove a card, or a spacer. An emptied column goes with it. */
export function removeSlot(boards: Boards, slotId: string): Boards {
  const at = locate(boards, slotId);
  if (!at) return boards;
  const items = toItems(boards);
  items[at.boardId] = items[at.boardId]!
    .map((col) => col.filter((s) => s.id !== slotId))
    .filter((col) => col.length > 0);
  return fromItems(boards, items);
}

/** Put a copy of a slot in a column of its own, just after the original's column. */
export function insertAfter(boards: Boards, slotId: string, copy: Slot): Boards {
  const at = locate(boards, slotId);
  if (!at) return boards;
  const items = toItems(boards);
  items[at.boardId]!.splice(at.index + 1, 0, [copy]);
  return fromItems(boards, items);
}

/** Append a slot to a board as a column of its own. */
export function append(boards: Boards, boardId: string, slot: Slot): Boards {
  if (!boards[boardId]) return boards;
  const items = toItems(boards);
  items[boardId]!.push([slot]);
  return fromItems(boards, items);
}

export type Nudge = "left" | "right" | "up" | "down";

/**
 * The arrow keys on a selected card.
 *
 * Left and right move a column, or a spacer, one place. A card inside a stack
 * leaves it instead, into a column of its own on that side. Up and down reorder a
 * card inside its stack; a column of one has nowhere to go.
 */
export function nudge(boards: Boards, slotId: string, dir: Nudge): Boards {
  const at = locate(boards, slotId);
  if (!at) return boards;
  const items = toItems(boards);
  const cols = items[at.boardId]!;
  const col = cols[at.index]!;
  if (dir === "up" || dir === "down") {
    const to = at.pos + (dir === "up" ? -1 : 1);
    if (to < 0 || to >= col.length) return boards;
    const next = [...col];
    [next[at.pos], next[to]] = [next[to]!, next[at.pos]!];
    cols[at.index] = next;
    return fromItems(boards, items);
  }
  const step = dir === "left" ? -1 : 1;
  if (col.length > 1 && !isSpacerItem(col)) {
    const slot = col[at.pos]!;
    cols[at.index] = col.filter((s) => s.id !== slotId);
    // `left` lands before the column, `right` after it.
    cols.splice(dir === "left" ? at.index : at.index + 1, 0, [slot]);
    return fromItems(boards, items);
  }
  const to = at.index + step;
  if (to < 0 || to >= cols.length) return boards;
  [cols[at.index], cols[to]] = [cols[to]!, cols[at.index]!];
  return fromItems(boards, items);
}

/** Apply a drop. The one place a drag's two halves meet. */
export function applyDrop(boards: Boards, drag: Drag, drop: Drop): Boards {
  return drop.kind === "gap"
    ? moveToGap(boards, drag, { boardId: drop.boardId, index: drop.index })
    : stackOnto(boards, drag, drop.targetId);
}

/** How many people-slots a board has: spacers are not slots. */
export function slotCount(slots: readonly Slot[]): number {
  return slots.filter((s) => !isSpacer(s)).length;
}
