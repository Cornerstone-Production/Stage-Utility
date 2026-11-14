// use-draft-keeper.ts — the plot editor keeps its unsaved items on the server as a draft
// (PUT /api/stageplots/plots/:id/draft), so a reload, a closed tab or a crash loses nothing.
//
// A change is stored a second after the last one, and on leaving the page (a keepalive
// request on pagehide). Every draft write and every Save runs one after another (`saving`), so
// a draft write can never land after the Save that replaces it and leave a draft of what was
// just saved; the keepalive cannot wait its turn, so it is not sent while a Save of the same
// items is on its way. A draft is kept on a version of the plot: when that moves and the items
// did not (a rename or a fade, here or elsewhere), it is stored again on the new one, so it
// never opens as saved elsewhere. A store that fails is tried again after 2 s, then 4,
// 8… up to 30, said once on the client log when it starts failing and once when it is kept
// again. A draft turned clean again (undo back to the saved plot) is deleted; a delete that
// fails is shown (`dropError`) and the draft opens again next time.
//
// What the editor shows follows from what is held here: nothing to keep, being kept, kept
// at a time, or not kept (and why). Only kept is safe to leave; see `unstored`.

import { useEffect, useRef, useState } from "react";

import { errorMessage } from "@main/services/errors";
import type { PlotDraft, PlotItem } from "@main/types/stageplots";

import type { ApiError } from "../../lib/api";
import { logToServer } from "../../lib/client-log";
import { useLatestRef } from "../../lib/use-latest-ref";
import { sameItems } from "./editor-state";
import { stageplotsApi } from "./stageplots-api";

/** How long after the last change the draft is stored. */
export const KEEP_DELAY_MS = 1000;
/** A failed store is tried again after this, doubling up to RETRY_MAX_MS. */
export const RETRY_FIRST_MS = 2000;
export const RETRY_MAX_MS = 30_000;

export type KeepStatus =
  /** Nothing unsaved. */
  | { kind: "idle" }
  /** The newest change is on its way. */
  | { kind: "keeping" }
  /** The newest change is on the server, as of `savedAt`. */
  | { kind: "kept"; savedAt: string }
  /** The last store failed, for `reason`; it is being tried again. */
  | { kind: "failed"; reason: string };

/** Why a request failed, in the banner's words. */
function failure(err: unknown): string {
  const status = (err as ApiError).status;
  return typeof status === "number" ? `the server refused it: ${errorMessage(err)}` : "the server did not answer";
}

export interface DraftKeeper {
  status: KeepStatus;
  /** The newest change is not on the server: leaving now would lose it. */
  unstored: boolean;
  /** Why the server still holds a draft that was meant to go, or null. */
  dropError: string | null;
  /**
   * Store the newest change now, after anything queued; true once it is on the server (or there
   * is nothing to store). `on`: the version to draw it on, after a Save moved the plot's version
   * before the editor drew again.
   */
  flush: (on?: number) => Promise<boolean>;
  /**
   * Run a Save of `items` once every draft write before it has finished, and before any after it
   * starts. While it is on its way, the page closing sends no draft of those items: the Save
   * deletes the draft as it lands, and a keepalive landing after it would put it back.
   */
  saving: <T>(items: PlotItem[], fn: () => Promise<T>) => Promise<T>;
  /** Stop waiting to store (a Save or a Discard is about to replace the draft). */
  hold: () => void;
  /** The plot changed: what the server keeps for it now (its draft, or none). Call during render. */
  reset: (kept: PlotDraft | null) => void;
  /** The server no longer has this plot's draft (it was saved). */
  forget: () => void;
}

/** Whether the draft the server holds, `kept`, is `now`: this plot's items, on this version. Anything else is not on the server yet. */
function isKept(kept: PlotDraft | null, now: { plotId: string | null; items: PlotItem[]; baseVersion: number }): boolean {
  return kept !== null && kept.plotId === now.plotId && kept.baseVersion === now.baseVersion && sameItems(kept.items, now.items);
}

export function useDraftKeeper({
  plotId,
  items,
  dirty,
  baseVersion,
  onKept,
  onDropped,
  onWriting,
}: {
  plotId: string | null;
  items: PlotItem[];
  dirty: boolean;
  baseVersion: number;
  onKept: (draft: PlotDraft) => void;
  onDropped: (plotId: string) => void;
  /** A write of the plot's draft is going out; call what it answers once it is done. */
  onWriting: (plotId: string) => () => void;
}): DraftKeeper {
  /** What the server holds as the open plot's draft: its items, the version they were drawn on, and since when. */
  const [kept, setKept] = useState<PlotDraft | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const latest = useLatestRef({ plotId, items, dirty, baseVersion, kept, onKept, onDropped, onWriting });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryMs = useRef(0);
  const failing = useRef(false);
  /** The items a Save on its way is sending, or null: the page closing sends no draft of them. */
  const inSave = useRef<PlotItem[] | null>(null);
  /** Unmounted: a store that fails after this sets no retry. */
  const gone = useRef(false);

  // Plain functions: every one reads what changes through `latest` and the refs above, never
  // from the render that made it, so a timer or an answer that outlives that render still acts
  // on the newest state.

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.current.then(fn, fn);
    queue.current = run.catch(() => undefined);
    return run;
  }

  function hold(): void {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  function store(forPlot: string, on?: number): Promise<boolean> {
    return serial(async () => {
      const now = latest.current;
      // The plot was left (its draft stored first, or let go), or there is nothing new.
      if (now.plotId !== forPlot || !now.dirty) return true;
      const sent = now.items;
      const base = on ?? now.baseVersion;
      if (isKept(now.kept, { plotId: forPlot, items: sent, baseVersion: base })) return true;
      const done = now.onWriting(forPlot);
      try {
        const r = await stageplotsApi.keepDraft(forPlot, base, sent);
        setKept({ plotId: forPlot, items: sent, baseVersion: r.baseVersion, savedAt: r.savedAt });
        setFailed(null);
        retryMs.current = 0;
        latest.current.onKept({ plotId: forPlot, baseVersion: r.baseVersion, items: sent, savedAt: r.savedAt });
        if (failing.current) {
          failing.current = false;
          logToServer("stageplots", `the unsaved draft of plot ${forPlot} is kept again`);
        }
        // Discarded (or undone back to the saved plot) while it was on its way: it goes again.
        if (latest.current.plotId === forPlot && !latest.current.dirty) void drop(forPlot);
        return true;
      } catch (err) {
        const reason = failure(err);
        setFailed(reason);
        if (!failing.current) {
          failing.current = true;
          logToServer("stageplots", `could not keep the unsaved draft of plot ${forPlot} (${reason}); trying again`);
        }
        retryMs.current = Math.min(RETRY_MAX_MS, retryMs.current === 0 ? RETRY_FIRST_MS : retryMs.current * 2);
        hold();
        // Not once the editor is gone: its last chance was the keepalive on pagehide.
        if (!gone.current) timer.current = setTimeout(() => void store(forPlot), retryMs.current);
        return false;
      } finally {
        done();
      }
    });
  }

  function drop(forPlot: string): Promise<string | null> {
    return serial(async () => {
      try {
        await stageplotsApi.discardDraft(forPlot);
        if (latest.current.kept?.plotId === forPlot) setKept(null);
        setDropError(null);
        latest.current.onDropped(forPlot);
        return null;
      } catch (err) {
        const reason = failure(err);
        setDropError(reason);
        logToServer("stageplots", `could not delete the unsaved draft of plot ${forPlot} (${reason}); it opens again next time`);
        return reason;
      }
    });
  }

  // A change, or the plot's version moving under unchanged items: stored a second after the
  // last one. Clean again (undo back to the saved plot): the server's draft goes.
  useEffect(() => {
    if (!plotId) return;
    if (!dirty) {
      hold();
      if (latest.current.kept?.plotId === plotId) void drop(plotId);
      return;
    }
    if (isKept(latest.current.kept, { plotId, items, baseVersion })) return;
    hold();
    timer.current = setTimeout(() => void store(plotId), KEEP_DELAY_MS);
    // hold, drop and store read only refs, whichever render made them; `latest` is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotId, items, dirty, baseVersion]);

  // Leaving the page: the newest change goes as a keepalive request, which outlives the page,
  // unless a Save on its way carries those very items.
  useEffect(() => {
    const onHide = () => {
      const now = latest.current;
      if (!now.plotId || !now.dirty || isKept(now.kept, now)) return;
      if (inSave.current && sameItems(inSave.current, now.items)) return;
      stageplotsApi.keepDraftOnLeave(now.plotId, now.baseVersion, now.items);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [latest]);

  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      hold();
    };
  }, []);

  const flush = (on?: number): Promise<boolean> => {
    const forPlot = latest.current.plotId;
    if (!forPlot) return Promise.resolve(true);
    hold();
    return store(forPlot, on);
  };

  const saving = <T,>(sending: PlotItem[], fn: () => Promise<T>): Promise<T> => {
    inSave.current = sending;
    return serial(fn).finally(() => {
      if (inSave.current === sending) inSave.current = null;
    });
  };

  const reset = (next: PlotDraft | null) => {
    setKept(next);
    setFailed(null);
    setDropError(null);
  };
  const forget = () => {
    setKept(null);
    setFailed(null);
  };

  const stored = !dirty || isKept(kept, { plotId, items, baseVersion });
  let status: KeepStatus = { kind: "keeping" };
  if (!dirty) status = { kind: "idle" };
  else if (stored && kept) status = { kind: "kept", savedAt: kept.savedAt };
  else if (failed !== null) status = { kind: "failed", reason: failed };
  return { status, unstored: !stored, dropError, flush, saving, hold, reset, forget };
}
