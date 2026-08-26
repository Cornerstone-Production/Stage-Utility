import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Channel names as LITERALS, not built from the platform id.
 *
 * api-channels.test.ts scans the UI for the channels it dispatches, and a
 * template string is invisible to it — the same shape of hole that once hid
 * ninety call sites behind a local wrapper. Spelling them out costs four lines
 * and keeps the guard able to notice when a caller disappears.
 */
const CHANNELS = {
  resi: { get: "resi:getStatus", push: "resi:status" },
  youtube: { get: "youtube:getStatus", push: "youtube:status" },
} as const;

/**
 * Live state of one streaming platform.
 *
 * ONE hook for both, parameterised by channel, where OBS and REAPER each got
 * their own file. Those two differ in what they report — a transport position
 * versus a record timecode — so a shared hook would have meant a union nobody
 * wanted. Resi and YouTube answer the same DTO, so a second copy of this would
 * be a second place to fix the same bug.
 *
 * Hydrates once on mount because the channel only broadcasts on change: a
 * display opened mid-service would otherwise sit blank until something moved.
 */
export function useStreamState(
  platform: "resi" | "youtube",
  enabled = true,
): StreamStatusDTO | null {
  const [state, setState] = useState<StreamStatusDTO | null>(null);
  const { get, push } = CHANNELS[platform];

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    invoke<StreamStatusDTO>(get)
      .then((s) => {
        if (!cancelled && s) setState(s);
      })
      .catch(() => {
        /* not configured yet — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, get]);

  useEffect(() => {
    if (!enabled) return;
    return onNotification(push, (p) => setState(p as StreamStatusDTO));
  }, [enabled, push]);

  return state;
}

export const useResiState = (enabled = true) => useStreamState("resi", enabled);
export const useYouTubeState = (enabled = true) => useStreamState("youtube", enabled);
