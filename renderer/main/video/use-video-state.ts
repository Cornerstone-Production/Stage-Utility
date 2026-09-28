import { useCallback } from "react";

import { invoke } from "../../lib/api";
import { useStatusChannel } from "../use-status-channel";
import type { VideoState } from "@main/types/video";

/** Subscribes to video:state only where something shows feeds — a Video
 *  widget, the Video feeds page, the inspector's Video section — so the channel
 *  is open only while it is being watched. The server does no polling for it:
 *  every change is pushed as it is made. */
export function useVideoState(): VideoState | null {
  const read = useCallback(() => invoke<VideoState>("video:state"), []);
  return useStatusChannel<VideoState>(read, "video:state");
}
