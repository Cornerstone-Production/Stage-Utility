import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

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

/** What each channel answers. YouTube's is the shared shape plus the two things
 *  only YouTube knows, so the map is what keeps the wider one from leaking onto
 *  Resi — a caller reading `viewers` off a Resi snapshot would be reading a
 *  field nothing sets. */
interface StreamDTOs {
  resi: StreamStatusDTO;
  youtube: YouTubeStatusDTO;
}

/**
 * Live state of one streaming platform.
 *
 * ONE hook for both, parameterised by channel, where OBS and REAPER each got
 * their own file. Those two differ in what they report — a transport position
 * versus a record timecode — so a shared hook would have meant a union nobody
 * wanted. Resi and YouTube answer the same shape, YouTube's with two more
 * fields on it, so a second copy of this would still be a second place to fix
 * the same bug. The generic is what keeps the difference honest at the call
 * site instead.
 *
 * Hydrates once on mount because the channel only broadcasts on change: a
 * display opened mid-service would otherwise sit blank until something moved.
 * Ordering between that hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have.
 */
export function useStreamState<P extends keyof StreamDTOs>(
  platform: P,
  enabled = true,
): StreamDTOs[P] | null {
  const { get, push } = CHANNELS[platform];
  const read = useCallback(() => invoke<StreamDTOs[P]>(get), [get]);
  return useStatusChannel<StreamDTOs[P]>(read, push, enabled);
}

export const useResiState = (enabled = true) => useStreamState("resi", enabled);
export const useYouTubeState = (enabled = true) => useStreamState("youtube", enabled);
