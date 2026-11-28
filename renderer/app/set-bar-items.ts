// Saving the context bar's arrangement.
//
// Its own module, apart from the editor that calls it: the bar is arranged in
// place, in Customize mode's Context bar tab (bar-editor.tsx), whichever way the
// mode was opened (the bar's own right-click menu, or Advanced > Layout).
//
// Each of the two sets is a list the server holds whole, saved one change at a
// time through use-saved-list.ts. This is how one reaches the server.

import type { QueryClient } from "@tanstack/react-query";

import { invoke } from "../lib/api";
import { QUERY_KEYS } from "./queries";
import { revisionOf, type Revised, type SavedListIo } from "./use-saved-list";
import { hasMobileBar, normalizeBarRows, visibleBarItems, type BarRowId } from "./bar-items";

/** Which of the two sets a save is for. */
export type BarSet = "desktop" | "mobile";

/** A row being edited. Spacers repeat, so a row needs an identity of its own:
 *  drags are addressed by key, and two rows sharing one swap with themselves. */
export interface BarEditRow {
  key: string;
  id: BarRowId;
}

export const sameBarIds = (rows: readonly BarEditRow[], ids: readonly BarRowId[]) =>
  rows.length === ids.length && rows.every((r, i) => r.id === ids[i]);

/** The set as the list the editor holds. The phone's is EMPTY while it follows the desktop bar. */
export function barRowsOf(state: Pick<StageState, "barItems" | "barMobileItems">, set: BarSet, nextKey: () => string): BarEditRow[] {
  if (set === "mobile" && !hasMobileBar(state.barMobileItems)) return [];
  const ids = visibleBarItems(set === "mobile" ? state.barMobileItems : state.barItems);
  return ids.map((id) => ({ key: nextKey(), id }));
}

/**
 * Write one of the bar's two orders and install what the server answers.
 *
 * ONE SET PER CALL, and the other is not sent at all. Sending both would mean
 * echoing back whatever this client last read for the set it is not editing —
 * so a phone saving its own strip would silently revert a desktop edit made
 * seconds earlier on another machine. The server leaves an absent list alone.
 *
 * Throws what the server refuses with; the caller says it. The bar is global
 * config, so a caller that closed a dialog on the strength of a failed write
 * would leave two operators looking at different bars.
 */
export async function saveBarSet(queryClient: QueryClient, set: BarSet, items: string[]): Promise<StageState> {
  const next = await invoke<StageState>("barItems:set", set === "mobile" ? { mobileItems: items } : { items });
  queryClient.setQueryData(QUERY_KEYS.stageState, next);
  return next;
}

/**
 * How one set reaches the server, for use-saved-list. Memoise it per set.
 *
 * Whatever is saved is normalised first (never nothing: a spacer at least), and
 * the answer keeps the rows' own keys when it says the same thing, so a save
 * that took as asked redraws nothing.
 */
export function barListIo(queryClient: QueryClient, set: BarSet, nextKey: () => string): SavedListIo<BarEditRow> {
  return {
    save: async (list) => {
      const next = await saveBarSet(queryClient, set, normalizeBarRows(list.map((r) => r.id)));
      const answered = barRowsOf(next, set, nextKey);
      return { list: sameBarIds(list, answered.map((r) => r.id)) ? list : answered, revision: revisionOf(next, "bar") };
    },
    read: async () => {
      const next = await invoke<StageState>("stage:getState");
      queryClient.setQueryData(QUERY_KEYS.stageState, next);
      return barAnswerOf(next, set, nextKey);
    },
  };
}

/** A state as the answer for one set: its rows and the bar's revision. */
export function barAnswerOf(state: StageState, set: BarSet, nextKey: () => string): Revised<BarEditRow> {
  return { list: barRowsOf(state, set, nextKey), revision: revisionOf(state, "bar") };
}
