// use-list-saves.ts — a list the server stores whole, saved one change at a time.
//
// Every control on such a page (a toggle, a picker, a reorder, a rename) saves the whole
// list the moment it is used. Two of those in quick succession on a slow link used to
// race: the first answer was adopted over the second edit, so the page went back on it
// and the next save sent the reverted list to the server; and a refused rename put back
// a copy of the list from before it, losing every edit made while it was in flight.
//
// So an edit is a function of the list, not a list. The page shows the server's last
// answer with every edit still waiting applied on top. One save is in flight at a time,
// and each is built from the newest answer when its turn comes, so an edit made while
// another is saving lands on top of it rather than on what the page held when it was
// clicked. One request per edit, not one per batch, so a refusal is pinned to the edit
// that caused it: that edit is dropped, the list is read back from the server, and the
// edits after it are applied to that.
//
// A step can also be a request of its own that answers with the whole list, such as the
// server adding roles for categories it reads itself. It waits its turn like an edit,
// and its answer is what the edits after it build on.

import { useCallback, useRef, useState } from "react";

import { errorMessage } from "@main/services/errors";

/** One change to the list, applied to whatever the list is when its turn to save comes. */
export type ListEdit<T> = (list: T[]) => T[];

export type ListSaveResult = { ok: true } | { ok: false; error: string };

/** How the list reaches the server. Must be stable: a module-level constant. */
export interface ListIo<T> {
  save: (list: T[]) => Promise<T[]>;
  read: () => Promise<T[]>;
}

type Step<T> = { edit: ListEdit<T> } | { request: () => Promise<T[]> };

export function useListSaves<T>(io: ListIo<T>): {
  /** What the page shows: the server's last answer with the waiting edits applied. */
  list: T[];
  /** Take a list the server answered a read with. */
  adopt: (list: T[]) => void;
  /** Queue an edit; resolves once it has been saved or refused. */
  edit: (e: ListEdit<T>) => Promise<ListSaveResult>;
  /** Queue a request that answers with the whole list; resolves once it has answered or failed. */
  request: (r: () => Promise<T[]>) => Promise<ListSaveResult>;
} {
  // Written only from handlers and from the save loop, never during render.
  const base = useRef<T[]>([]);
  const queue = useRef<{ step: Step<T>; done: (r: ListSaveResult) => void }[]>([]);
  const saving = useRef(false);
  const [list, setList] = useState<T[]>([]);

  const redraw = useCallback(() => {
    // An edit that throws is drawn as no change; its failure is returned when its turn
    // to save comes (saveOne), so it is reported there, not lost. A request changes
    // nothing on screen until it answers.
    setList(queue.current.reduce((l, q) => {
      if (!("edit" in q.step)) return l;
      try {
        return q.step.edit(l);
      } catch {
        return l;
      }
    }, base.current));
  }, []);

  const adopt = useCallback((l: T[]) => {
    base.current = l;
    redraw();
  }, [redraw]);

  const saveOne = useCallback(async (step: Step<T>): Promise<ListSaveResult> => {
    try {
      if ("edit" in step) {
        // Inside the try: an edit that throws is refused like a save the server refused,
        // rather than staying at the head of the queue with every edit behind it waiting.
        const next = step.edit(base.current);
        if (next === base.current) return { ok: true }; // nothing to change (a move past the end)
        base.current = await io.save(next);
      } else {
        base.current = await step.request();
      }
      return { ok: true };
    } catch (err) {
      // Refused or failed, the server may hold something other than the last answer
      // (another window saved meanwhile), so the edits still waiting are applied to what
      // it holds now.
      const reason = errorMessage(err);
      try {
        base.current = await io.read();
      } catch (readErr) {
        return { ok: false, error: `${reason} The list could not be read back, so it may be out of date (${errorMessage(readErr)}).` };
      }
      return { ok: false, error: reason };
    }
  }, [io]);

  const drain = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      for (let head = queue.current[0]; head; head = queue.current[0]) {
        const result = await saveOne(head.step);
        queue.current.shift();
        redraw();
        head.done(result);
      }
    } finally {
      saving.current = false;
    }
  }, [saveOne, redraw]);

  const enqueue = useCallback((step: Step<T>) => new Promise<ListSaveResult>((done) => {
    queue.current.push({ step, done });
    redraw();
    void drain();
  }), [drain, redraw]);

  const edit = useCallback((e: ListEdit<T>) => enqueue({ edit: e }), [enqueue]);
  const request = useCallback((r: () => Promise<T[]>) => enqueue({ request: r }), [enqueue]);

  return { list, adopt, edit, request };
}
