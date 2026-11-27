// use-saved-list.ts — a list the server holds whole and the shell edits in place.
//
// The sidebar's arrangement and each of the context bar's two sets are saved the
// way the ServiceCue page saves its lists (lib/use-list-saves.ts): an edit is a
// function of the list, one save is out at a time, and what is drawn is the
// server's last answer with every edit still waiting applied on top. This adds
// what a list that is also BROADCAST needs, which the page's lists are not:
// taking in another browser's change without taking in our own echo.
//
// That is told by the server's count of saves (StageState.listRevisions), never
// by value: our own echo and another browser's change can be the same list (add a
// Space, take it off, and another browser adds one), and a late echo of an older
// save of ours can arrive after another browser's newer one. Every answer and
// every broadcast carries the count, and this remembers the newest it has held.
//
// The rules for a broadcast (`saved`, the state the server pushed):
//  - While an edit of ours is queued or out, it is not taken in. Drawing the echo
//    of a save under an edit that is still waiting would apply that edit twice
//    (a second Space, say), and the answer to the save is what the list builds on.
//  - Once nothing is waiting, it is taken in only if its count is newer than the
//    newest answer or broadcast already held. A restarted server's first count is
//    newer than any of the run before; that run's counts are never newer again.
//    Our own echo, early or late, never is newer; another browser's change that
//    landed after our last save always is, even if it arrived while that save was out.
//  - A newer one that says what the list already holds is noted, not redrawn.
//  - Not while `hold` is true (a drag in progress: the rows measured at its start
//    must stay). It is taken in when the hold ends.

import { useCallback, useEffect, useMemo, useRef } from "react";

import { useListSaves, type ListEdit, type ListIo, type ListSaveResult, type ListStepResult } from "../lib/use-list-saves";

/** Which save of a list a reading of it is. A different `boot` is a restarted server. */
export interface Revision {
  boot: string;
  n: number;
}

/** A list as the server answered it, with the save it is. */
export interface Revised<T> {
  list: T[];
  revision: Revision;
}

/** How a list reaches the server, each answer carrying its revision. Must be stable. */
export interface SavedListIo<T> {
  save: (list: T[]) => Promise<Revised<T>>;
  read: () => Promise<Revised<T>>;
}

/** A state's revision of one of its broadcast lists. A server that sends none reads as 0. */
export function revisionOf(state: Pick<StageState, "listRevisions"> | null | undefined, list: "sidebar" | "bar"): Revision {
  const r = state?.listRevisions;
  return { boot: r?.boot ?? "", n: r?.[list] ?? 0 };
}

export interface SavedList<T> {
  /** What to draw: the server's last answer with the waiting edits applied. Empty until the first broadcast is taken in. */
  list: T[];
  /**
   * Queue an edit; resolves once it has been saved or refused, with what it changed
   * and what it was applied to. Named as useListSaves names the same thing: there,
   * `edit` answers only {ok} (the ServiceCue page reads it so) and `editTracked`
   * answers this. Every caller here wants the toast and the Undo, so only this one.
   */
  editTracked: (e: ListEdit<T>) => Promise<ListStepResult<T>>;
  /** Queue a request that answers with the whole list; resolves once it has answered or failed. */
  request: (r: () => Promise<Revised<T>>) => Promise<ListSaveResult>;
}

/**
 * @param io How the list reaches the server. Must be stable (a module-level constant or a memo).
 * @param saved The list as broadcast, or null before any state has arrived.
 * @param revision The revision `saved` was broadcast at.
 * @param keyOf A string that is equal for two lists that mean the same thing. Row keys a drag uses are not part of it.
 * @param hold True while a broadcast must not be taken in.
 */
export function useSavedList<T>({
  io,
  saved,
  revision,
  keyOf,
  hold = false,
}: {
  io: SavedListIo<T>;
  saved: T[] | null;
  revision: Revision;
  keyOf: (list: T[]) => string;
  hold?: boolean;
}): SavedList<T> {
  /** The newest revision held, answered or broadcast. Null until the first, which anything is newer than. */
  const newest = useRef<Revision | null>(null);
  /**
   * Boots this list has seen a later run replace. A new boot is newer than the run
   * before it, but not the other way round: after a restart, the state the old run
   * last broadcast can still be what the page holds (the stream has not reconnected)
   * when an answer from the new run arrives, and must not be drawn over it.
   */
  const retired = useRef(new Set<string>());
  /** Hold `r` as the newest if it is newer; whether it was. */
  const take = useCallback((r: Revision): boolean => {
    if (retired.current.has(r.boot)) return false;
    const held = newest.current;
    if (held !== null && r.boot === held.boot && r.n <= held.n) return false;
    if (held !== null && r.boot !== held.boot) retired.current.add(held.boot);
    newest.current = r;
    return true;
  }, []);
  const unwrap = useCallback(async (answer: Promise<Revised<T>>): Promise<T[]> => {
    const { list, revision: r } = await answer;
    take(r);
    return list;
  }, [take]);
  const counted = useMemo<ListIo<T>>(() => ({ save: (l) => unwrap(io.save(l)), read: () => unwrap(io.read()) }), [io, unwrap]);
  const { list, adopt, editTracked, request: queueRequest, pending } = useListSaves(counted);
  const request = useCallback((r: () => Promise<Revised<T>>) => queueRequest(() => unwrap(r())), [queueRequest, unwrap]);

  const savedKey = saved === null ? null : keyOf(saved);
  const drawnKey = keyOf(list);
  const { boot, n } = revision;
  const latest = useRef(saved);
  useEffect(() => {
    latest.current = saved;
  });
  useEffect(() => {
    const broadcast = latest.current;
    if (broadcast === null || pending > 0 || hold) return;
    if (!take({ boot, n })) return;
    if (savedKey !== drawnKey) adopt(broadcast);
  }, [savedKey, drawnKey, boot, n, pending, hold, adopt, take]);

  return { list, editTracked, request };
}
