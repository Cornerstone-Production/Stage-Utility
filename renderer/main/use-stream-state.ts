import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/** The SSE channel carrying each platform's live frames. */
const PUSH = { resi: "resi:status", youtube: "youtube:status" } as const;

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
 *
 * The hydrate comes in as `read` rather than being looked up from the platform,
 * so each platform's invoke call and its channel are written in the hook that
 * sends it: api-channels.test.ts credits a channel only to a call that names
 * it, and cannot tell which entry a table read through the platform sends.
 */
export function useStreamState<P extends keyof StreamDTOs>(
  platform: P,
  read: () => Promise<StreamDTOs[P]>,
  enabled = true,
): StreamDTOs[P] | null {
  return useStatusChannel<StreamDTOs[P]>(read, PUSH[platform], enabled);
}

export function useResiState(enabled = true) {
  const read = useCallback(() => invoke<StreamDTOs["resi"]>("resi:getStatus"), []);
  return useStreamState("resi", read, enabled);
}

export function useYouTubeState(enabled = true) {
  const read = useCallback(() => invoke<StreamDTOs["youtube"]>("youtube:getStatus"), []);
  return useStreamState("youtube", read, enabled);
}
