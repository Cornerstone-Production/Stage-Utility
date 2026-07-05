import { useState, useEffect } from "react";
import { invoke, onNotification } from "../lib/api";

/**
 * Live ProdCom transcript: backfills the recent buffer once on mount, then
 * replaces it with each "prodcom:transcript" broadcast (the server sends the
 * whole rolling buffer). Oldest → newest. Used by the transcription display and
 * the dashboard/stage transcript tile.
 */
export function useTranscript(enabled = true): TranscriptLineDTO[] {
  const [lines, setLines] = useState<TranscriptLineDTO[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<TranscriptLineDTO[]>("prodcom:getTranscript")
      .then((b) => {
        if (!cancelled && Array.isArray(b)) setLines(b);
      })
      .catch(() => {
        /* not configured yet — ignore */
      });
    const unsub = onNotification("prodcom:transcript", (p) => {
      if (Array.isArray(p)) setLines(p as TranscriptLineDTO[]);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [enabled]);

  return lines;
}
