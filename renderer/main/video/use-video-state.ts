import { useCallback } from "react";

import { invoke } from "../../lib/api";
import { useStatusChannel } from "../use-status-channel";
import type { VideoState } from "@main/types/video";

/** Subscribes only where a Video widget or the Video feeds page is mounted, which
 *  is what lets the server poll the relay only while something watches. */
export function useVideoState(): VideoState | null {
  const read = useCallback(() => invoke<VideoState>("video:state"), []);
  return useStatusChannel<VideoState>(read, "video:state");
}
