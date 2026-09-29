import { useCallback } from "react";

import { invoke } from "../../lib/api";
import { useStatusChannel } from "../use-status-channel";
import type { VideoState } from "@main/types/video";

/** Subscribes to video:state only where something shows feeds or a screen's
 *  own health — a Video widget, the Video feeds page, the inspector's Video
 *  section, the Screens page — so the channel is open only while it is being
 *  watched. While a relay is attached, an open subscriber DOES start the
 *  relay's own status poll on the server (see video-service.ts's
 *  STATUS_POLL_MS) — but that poll only ever broadcasts on a real change:
 *  `screens` is a cache the poll's own read never touches, so it running
 *  alongside a quiet building pushes nothing here on its own. */
export function useVideoState(): VideoState | null {
  const read = useCallback(() => invoke<VideoState>("video:state"), []);
  return useStatusChannel<VideoState>(read, "video:state");
}
