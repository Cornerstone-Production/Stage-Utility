// use-saved-list.ts — a list the server holds whole and the shell edits in place.
//
// The sidebar's arrangement and each of the context bar's two sets are saved the
// way the ServiceCue page saves its lists (lib/use-list-saves.ts): an edit is a
// function of the list, one save is out at a time, and what is drawn is the
// server's last answer with every edit still waiting applied on top. This adds
// what a list that is also BROADCAST needs, which the page's lists are not:
// taking in another browser's change without taking in our own echo.
//
// The rules for a broadcast (`saved`, the state the server pushed):
//  - While an edit of ours is queued or out, it is not taken in. Drawing the echo
//    of a save under an edit that is still waiting would apply that edit twice
//    (a second Space, say), and the answer to the save is what the list builds on.
//  - Once nothing is waiting, a broadcast is taken in unless it is the echo of
//    something this list already got as an answer, however late: a late echo of
//    an older save must not draw the list back over a newer answer. Each echo
//    consumes its answer, so the same list arriving again from elsewhere is news.
//  - So a change another browser made while a save was out, which is not an echo
//    of any answer of ours, is still taken in when the queue empties.
//  - Not while `hold` is true (a drag in progress: the rows measured at its start
//    must stay). It is taken in when the hold ends.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useListSaves, type ListEdit, type ListIo, type ListSaveResult } from "../lib/use-list-saves";

/** How many answers are remembered to tell an echo from another browser's change. */
const REMEMBERED_ANSWERS = 16;

export interface SavedList<T> {
  /** What to draw: the server's last answer with the waiting edits applied. Empty until the first broadcast is taken in. */
  list: T[];
  /** Queue an edit; resolves once it has been saved or refused. */
  edit: (e: ListEdit<T>) => Promise<ListSaveResult>;
  /** Queue a request that answers with the whole list; resolves once it has answered or failed. */
  request: (r: () => Promise<T[]>) => Promise<ListSaveResult>;
}

/**
 * @param io How the list reaches the server. Must be stable (a module-level constant or a memo).
 * @param saved The list as broadcast, or null before any state has arrived.
 * @param keyOf A string that is equal for two lists that mean the same thing. Row keys a drag uses are not part of it.
 * @param hold True while a broadcast must not be taken in.
 */
export function useSavedList<T>({
  io,
  saved,
  keyOf,
  hold = false,
}: {
  io: ListIo<T>;
  saved: T[] | null;
  keyOf: (list: T[]) => string;
  hold?: boolean;
}): SavedList<T> {
  const answers = useRef<string[]>([]);
  const remembering = useMemo<ListIo<T>>(() => {
    const remember = (list: T[]): T[] => {
      answers.current = [...answers.current.slice(1 - REMEMBERED_ANSWERS), keyOf(list)];
      return list;
    };
    return { save: async (l) => remember(await io.save(l)), read: async () => remember(await io.read()) };
  }, [io, keyOf]);
  const { list, adopt, edit: queueEdit, request: queueRequest } = useListSaves(remembering);

  // Edits queued or out. A state, so that the render in which the queue empties
  // is the one whose effect looks at the broadcast again.
  const [waiting, setWaiting] = useState(0);
  const track = useCallback(async (run: () => Promise<ListSaveResult>): Promise<ListSaveResult> => {
    setWaiting((n) => n + 1);
    try {
      return await run();
    } finally {
      setWaiting((n) => n - 1);
    }
  }, []);
  const edit = useCallback((e: ListEdit<T>) => track(() => queueEdit(e)), [track, queueEdit]);
  const request = useCallback((r: () => Promise<T[]>) => track(() => queueRequest(r)), [track, queueRequest]);

  const savedKey = saved === null ? null : keyOf(saved);
  const handled = useRef<string | null>(null);
  const latest = useRef(saved);
  useEffect(() => {
    latest.current = saved;
  });
  useEffect(() => {
    const broadcast = latest.current;
    if (broadcast === null || savedKey === handled.current) return;
    if (waiting > 0 || hold) return;
    handled.current = savedKey;
    // Broadcasts arrive in the order the server saved, so an echo also consumes the
    // answers before it: another browser later putting the list back to one of them
    // is then news, not a repeat.
    const echoOf = answers.current.lastIndexOf(savedKey!);
    if (echoOf >= 0) {
      answers.current = answers.current.slice(echoOf + 1);
      return;
    }
    answers.current = [];
    adopt(broadcast);
  }, [savedKey, waiting, hold, adopt]);

  return { list, edit, request };
}
