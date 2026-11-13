// use-stageplots.ts — the stage plots document, read once and then live.
//
// GET /api/stageplots on mount; every change anywhere broadcasts the whole
// document on stageplots:updated, which replaces it here. The editor also
// calls refresh() after each of its own saves, so its change shows even if
// the event stream is reconnecting at that moment.
//
// A read never puts back a document older than a broadcast: a broadcast that
// lands while a read is out is at least as new as the read, so the read is
// dropped (the rule useStatusChannel keeps, which has no refresh to offer).

import { useCallback, useEffect, useRef, useState } from "react";

import { STAGEPLOTS_CHANNEL, type StagePlotsView } from "@main/types/stageplots";

import { onNotification } from "../../lib/api";
import { logReadFailure } from "../../lib/client-log";
import { stageplotsApi } from "./stageplots-api";

export interface StagePlotsState {
  doc: StagePlotsView | null;
  loading: boolean;
  /** The last read failed and no broadcast has answered since. */
  error: boolean;
  /** Read the document again, as after a save. */
  refresh: () => Promise<void>;
}

export function useStagePlots(): StagePlotsState {
  const [doc, setDoc] = useState<StagePlotsView | null>(null);
  const [known, setKnown] = useState(false);
  const [error, setError] = useState(false);
  /** Live broadcasts heard so far: a read that started before one is older than it. */
  const pushes = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    const at = pushes.current;
    return stageplotsApi.get().then(
      (read) => {
        if (pushes.current === at) setDoc(read);
        setError(false);
        setKnown(true);
      },
      (err: unknown) => {
        logReadFailure("stageplots", "the stage plots", err);
        setError(true);
        setKnown(true);
      },
    );
  }, []);

  useEffect(() => {
    // Subscribed before the read goes out, so no change can fall between them.
    const off = onNotification(STAGEPLOTS_CHANNEL, (payload, replayed) => {
      if (!replayed) pushes.current++;
      setDoc(payload as StagePlotsView);
      setError(false);
      setKnown(true);
    });
    void refresh();
    return off;
  }, [refresh]);

  return { doc, loading: !known, error, refresh };
}
