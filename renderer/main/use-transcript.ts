import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/** Stable identity, so a hook with nothing yet does not hand a new array out per render. */
const NO_LINES: TranscriptLineDTO[] = [];

/**
 * Live ProdCom transcript: backfills the recent buffer once on mount, then
 * replaces it with each "prodcom:transcript" broadcast (the server sends the
 * whole rolling buffer). Oldest → newest. Used by the transcription display and
 * the dashboard/stage transcript tile.
 *
 * Ordering between the backfill and the first push is useStatusChannel's job —
 * see the note there. The buffer is the whole state, so a read landing after a
 * push does not merely lag, it DELETES the lines that push carried.
 *
 * The Array.isArray guard stays: every consumer maps over the answer, and a
 * malformed frame must cost a blank tile rather than a thrown render.
 */
export function useTranscript(enabled = true): TranscriptLineDTO[] {
  const read = useCallback(() => invoke<TranscriptLineDTO[]>("prodcom:getTranscript"), []);
  const lines = useStatusChannel<TranscriptLineDTO[]>(read, "prodcom:transcript", enabled);
  return Array.isArray(lines) ? lines : NO_LINES;
}
