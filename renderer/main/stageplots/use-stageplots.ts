// use-stageplots.ts — the stage plots document, read once and then live.
//
// GET /api/stageplots on mount; every change anywhere broadcasts the whole
// document on stageplots:updated, which replaces it here. The editor also
// calls refresh() after each of its own saves, so its change shows even if
// the event stream is reconnecting at that moment.
//
// useStatusChannel keeps the order: a read never puts back a document older than
// a broadcast that went out while it was on its way. refresh() opens a fresh
// window (subscribed again, read again). A failed read is said on /log.

import { useCallback, useState } from "react";

import { STAGEPLOTS_CHANNEL, type StagePlotsView } from "@main/types/stageplots";

import { logReadFailure } from "../../lib/client-log";
import { useStatusChannel } from "../use-status-channel";
import { stageplotsApi } from "./stageplots-api";

export interface StagePlotsState {
  doc: StagePlotsView | null;
  loading: boolean;
  /** The last read failed and no broadcast has answered since. */
  error: boolean;
  /** Read the document again, as after a save. */
  refresh: () => void;
}

const onReadFailure = (err: unknown) => logReadFailure("stageplots", "the stage plots", err);

export function useStagePlots(): StagePlotsState {
  const [reads, setReads] = useState(0);
  const { value, known, failed } = useStatusChannel(stageplotsApi.get, STAGEPLOTS_CHANNEL, true, { resubscribeKey: reads, onReadFailure });
  const refresh = useCallback(() => setReads((n) => n + 1), []);
  return { doc: value, loading: !known && value === null, error: failed, refresh };
}
