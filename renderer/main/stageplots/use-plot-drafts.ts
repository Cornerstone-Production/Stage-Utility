// use-plot-drafts.ts — the editor's kept drafts, read once and then followed.
//
// GET /api/stageplots/drafts when the editor mounts (it waits for this read: a draft it has
// not seen must never be stored over); then stageplots:drafts, which names the plots that
// have a draft and when each was kept, never the items. A note newer than the draft held
// here (another desk kept one) reads the drafts again; a note about a plot this editor is
// writing does not (the server broadcasts before it answers, and the answer is what this
// editor keeps). A read that a later note overtook is dropped and made again, so an older
// answer never puts back a draft that has gone. A read after the first that fails is made
// again after 2 s, then 4, 8… up to 30, until it reads: until then the drafts held here may
// miss one another desk kept, which this editor would store over. Not part of the SSE hello
// burst: like the document itself, the drafts are read on mount.

import { useCallback, useEffect, useRef, useState } from "react";

import { STAGEPLOT_DRAFTS_CHANNEL, type PlotDraft, type PlotDraftNotes } from "@main/types/stageplots";

import { onNotification } from "../../lib/api";
import { logReadFailure } from "../../lib/client-log";
import { nextRetryDelay } from "../../lib/retry-delay";
import { stageplotsApi } from "./stageplots-api";

/** A failed re-read is made again after this, doubling up to DRAFTS_RETRY_MAX_MS. */
export const DRAFTS_RETRY_FIRST_MS = 2000;
export const DRAFTS_RETRY_MAX_MS = 30_000;

export interface PlotDraftsState {
  /** Every kept draft by plot; null until the first read answers. */
  drafts: ReadonlyMap<string, PlotDraft> | null;
  /** The last read failed. */
  error: boolean;
  /** This editor kept a draft, or saved, discarded or reloaded one: the server agrees, and a note need not read it back. */
  kept: (draft: PlotDraft) => void;
  dropped: (plotId: string) => void;
  /** Read the drafts again. */
  refresh: () => Promise<void>;
  /** This editor is writing the plot's draft: its note is its own, not news. Call what it answers when the write is done. */
  writing: (plotId: string) => () => void;
}

export function usePlotDrafts(): PlotDraftsState {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, PlotDraft> | null>(null);
  const [error, setError] = useState(false);
  const held = useRef<ReadonlyMap<string, PlotDraft> | null>(null);
  /** Notes heard so far: a read that started before one is older than it. */
  const heard = useRef(0);
  /** Plots whose draft this editor is writing now. */
  const ours = useRef(new Map<string, number>());
  /** The read made again after one failed, and how long the one after it waits. */
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryMs = useRef(0);
  const gone = useRef(false);

  const replace = useCallback((next: ReadonlyMap<string, PlotDraft>) => {
    held.current = next;
    setDrafts(next);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const attempt = (): Promise<void> => {
      const at = heard.current;
      return stageplotsApi.drafts().then(
        (r) => {
          // Overtaken by a note while it was out: what it read may be older than that note.
          if (heard.current !== at && held.current !== null) return attempt();
          replace(new Map(r.drafts.map((d) => [d.plotId, d])));
          setError(false);
          retryMs.current = 0;
        },
        (err: unknown) => {
          logReadFailure("stageplots", "the unsaved plot drafts", err);
          setError(true);
          // The first read's failure is the page's to show (it waits for it). A later one would
          // leave the held drafts behind the server's: read again until it reads.
          if (held.current === null || gone.current || retry.current) return;
          retryMs.current = nextRetryDelay(retryMs.current, DRAFTS_RETRY_FIRST_MS, DRAFTS_RETRY_MAX_MS);
          retry.current = setTimeout(() => {
            retry.current = null;
            void attempt();
          }, retryMs.current);
        },
      );
    };
    return attempt();
  }, [replace]);

  useEffect(() => {
    // Subscribed before the read goes out, so no note can fall between them.
    const off = onNotification(STAGEPLOT_DRAFTS_CHANNEL, (payload) => {
      const notes = (payload as PlotDraftNotes).drafts;
      heard.current++;
      const now = held.current;
      if (!now) return;
      const named = new Set(notes.map((n) => n.plotId));
      // A draft kept elsewhere, or kept again since the one held here: read them all again.
      if (notes.some((n) => !ours.current.has(n.plotId) && now.get(n.plotId)?.savedAt !== n.savedAt)) return void refresh();
      // Only drafts that went (saved, discarded, or their plot deleted): drop them here too.
      if ([...now.keys()].some((id) => !named.has(id))) replace(new Map([...now].filter(([id]) => named.has(id))));
    });
    void refresh();
    gone.current = false;
    return () => {
      off();
      gone.current = true;
      if (retry.current) clearTimeout(retry.current);
      retry.current = null;
    };
  }, [refresh, replace]);

  const kept = useCallback((draft: PlotDraft) => replace(new Map(held.current).set(draft.plotId, draft)), [replace]);
  const dropped = useCallback(
    (plotId: string) => {
      if (!held.current?.has(plotId)) return;
      const next = new Map(held.current);
      next.delete(plotId);
      replace(next);
    },
    [replace],
  );

  const writing = useCallback((plotId: string) => {
    ours.current.set(plotId, (ours.current.get(plotId) ?? 0) + 1);
    return () => {
      const n = (ours.current.get(plotId) ?? 1) - 1;
      if (n > 0) ours.current.set(plotId, n);
      else ours.current.delete(plotId);
    };
  }, []);

  return { drafts, error, kept, dropped, refresh, writing };
}
