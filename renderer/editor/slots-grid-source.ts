// What the layout editor shows for a slots widget: "Define here" or "Embed a
// view", and whether the slot editor below the canvas may edit its board.
//
// A widget now points at a board, and a board can be the one a slots screen
// shows. Read as "Define here", a widget on a screen's board would let the
// editor below the canvas rewrite that screen's live wall as if it were the
// widget's own. So a widget on a screen's board reads as embedding that screen,
// and the editor below appears only for a board no screen shows. Choosing
// "Define here" for one gives it its own copy of the board when the layout is
// saved (the server's pointLayoutGrids); until then there is nothing of its own
// to edit.

import { viewBoardId } from "@main/services/slot-boards";
import type { LayoutObject, LayoutObjectConfig, View } from "@main/types/stage";

type GridConfig = Extract<LayoutObjectConfig, { type: "slots-grid" }>;

export interface SlotsGridSource {
  mode: "inline" | "view";
  /** The slots screen it embeds, by its pick or by sharing its board. */
  embeds: View | null;
  /** "Define here" picked over a screen's board, waiting for a save to copy it. */
  awaitingCopy: boolean;
  /** The slot editor below the canvas may edit this widget's board. */
  editsBelow: boolean;
}

export function slotsGridSource(c: GridConfig, slotsViews: readonly View[]): SlotsGridSource {
  const screenOf = (boardId: unknown): View | null =>
    typeof boardId === "string" && boardId ? (slotsViews.find((v) => viewBoardId(v) === boardId) ?? null) : null;
  if (c.source === "view") {
    return { mode: "view", embeds: slotsViews.find((v) => v.id === c.sourceViewId) ?? null, awaitingCopy: false, editsBelow: false };
  }
  const screen = screenOf(c.boardId);
  if (c.source === "inline") return { mode: "inline", embeds: null, awaitingCopy: screen !== null, editsBelow: screen === null };
  if (typeof c.boardId === "string" && c.boardId && !screen) {
    return { mode: "inline", embeds: null, awaitingCopy: false, editsBelow: true };
  }
  return { mode: "view", embeds: screen, awaitingCopy: false, editsBelow: false };
}

/**
 * The editor's objects with each slots widget it sent in the shape before boards
 * (a "Define here" or "Embed a view" choice) taking the board pointer the saved
 * layout gave it. Without this the widget keeps reading as "save to copy" until
 * the editor is reopened. Answers `local` itself when nothing changed.
 */
export function adoptSavedGridPointers(local: LayoutObject[], saved: readonly LayoutObject[]): LayoutObject[] {
  const savedConfig = new Map<string, LayoutObjectConfig>();
  const collect = (objs: readonly LayoutObject[]): void => {
    for (const o of objs) {
      if (o.config.type === "slots-grid") savedConfig.set(o.id, o.config);
      if (o.children) collect(o.children);
    }
  };
  collect(saved);
  let changed = false;
  const adopt = (objs: LayoutObject[]): LayoutObject[] =>
    objs.map((o) => {
      let next = o;
      const fresh = savedConfig.get(o.id);
      if (o.config.type === "slots-grid" && "source" in o.config && fresh && !("source" in fresh)) {
        next = { ...next, config: fresh };
        changed = true;
      }
      if (o.children) {
        const children = adopt(o.children);
        if (children !== o.children) next = { ...next, children };
      }
      return next;
    });
  const out = adopt(local);
  return changed ? out : local;
}
