// use-layout-saves.ts — the ServiceCue layouts editor's saves, one at a time.
//
// Every control on the page (a toggle, a picker, a reorder, a rename) saves the whole
// list the moment it is used. Two of those in quick succession on a slow link used to
// race: the first answer was adopted over the second edit, so the page went back on
// it and the next save sent the reverted list to the server; and a refused rename put
// back a copy of the list from before it, losing every edit made while it was in flight.
//
// So an edit is a function of the list, not a list. The page shows the server's last
// answer with every edit still waiting applied on top. One save is in flight at a time,
// and each is built from the newest answer when its turn comes, so an edit made while
// another is saving lands on top of it rather than on what the page held when it was
// clicked. One request per edit, not one per batch, so a refusal is pinned to the edit
// that caused it: that edit is dropped, the list is read back from the server, and the
// edits after it are applied to that.

import { useCallback, useRef, useState } from "react";

import { errorMessage } from "@main/services/errors";
import { invoke } from "../../lib/api";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

/** One change to the list, applied to whatever the list is when its turn to save comes. */
export type LayoutEdit = (list: ServiceCueLayout[]) => ServiceCueLayout[];

export type LayoutSaveResult = { ok: true } | { ok: false; error: string };

export function useLayoutSaves(): {
  /** What the page shows: the server's last answer with the waiting edits applied. */
  layouts: ServiceCueLayout[];
  /** Take a list the server answered a read with. */
  adopt: (list: ServiceCueLayout[]) => void;
  /** Queue an edit; resolves once it has been saved or refused. */
  edit: (e: LayoutEdit) => Promise<LayoutSaveResult>;
} {
  // Written only from handlers and from the save loop, never during render.
  const base = useRef<ServiceCueLayout[]>([]);
  const queue = useRef<{ edit: LayoutEdit; done: (r: LayoutSaveResult) => void }[]>([]);
  const saving = useRef(false);
  const [layouts, setLayouts] = useState<ServiceCueLayout[]>([]);

  const redraw = useCallback(() => {
    // An edit that throws is drawn as no change; its failure is returned when its turn
    // to save comes (saveOne), so it is reported there, not lost.
    setLayouts(queue.current.reduce((list, q) => {
      try {
        return q.edit(list);
      } catch {
        return list;
      }
    }, base.current));
  }, []);

  const adopt = useCallback((list: ServiceCueLayout[]) => {
    base.current = list;
    redraw();
  }, [redraw]);

  const saveOne = useCallback(async (e: LayoutEdit): Promise<LayoutSaveResult> => {
    try {
      // Inside the try: an edit that throws is refused like a save the server refused,
      // rather than staying at the head of the queue with every edit behind it waiting.
      const next = e(base.current);
      if (next === base.current) return { ok: true }; // nothing to change (a move past the end)
      base.current = await invoke<ServiceCueLayout[]>("servicecue:saveLayouts", { layouts: next });
      return { ok: true };
    } catch (err) {
      // Refused or failed, the server may hold something other than the last answer
      // (another window saved meanwhile), so the edits still waiting are applied to what
      // it holds now.
      const reason = errorMessage(err);
      try {
        base.current = await invoke<ServiceCueLayout[]>("servicecue:listLayouts");
      } catch (readErr) {
        return { ok: false, error: `${reason} The list could not be read back, so it may be out of date (${errorMessage(readErr)}).` };
      }
      return { ok: false, error: reason };
    }
  }, []);

  const drain = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      for (let head = queue.current[0]; head; head = queue.current[0]) {
        const result = await saveOne(head.edit);
        queue.current.shift();
        redraw();
        head.done(result);
      }
    } finally {
      saving.current = false;
    }
  }, [saveOne, redraw]);

  const edit = useCallback((e: LayoutEdit) => new Promise<LayoutSaveResult>((done) => {
    queue.current.push({ edit: e, done });
    redraw();
    void drain();
  }), [drain, redraw]);

  return { layouts, adopt, edit };
}
