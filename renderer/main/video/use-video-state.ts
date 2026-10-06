import { useCallback, useEffect, useState } from "react";

import { invoke } from "../../lib/api";
import { useStatusChannel } from "../use-status-channel";
import type { VideoProbeState, VideoState } from "@main/types/video";

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
  return useStatusChannel<VideoState>(read, "video:state").value;
}

/** The camera checks for pulled feeds. Subscribing to `video:probe` IS what
 *  starts them on the server (every 15 s, only while a client names the
 *  channel), so only the Video feeds page calls this. `probe` is null until
 *  the first frame or read; `receivedAt` is performance.now() when the
 *  current one arrived, which is what an age is counted from. */
export function useVideoProbe(): { probe: VideoProbeState | null; receivedAt: number } {
  const read = useCallback(() => invoke<VideoProbeState>("video:probe"), []);
  const value = useStatusChannel<VideoProbeState>(read, "video:probe").value;
  // Stamped when the frame lands, on a monotonic clock. That is a reaction to
  // an external system handing over a new value, which is what an effect is
  // for; reading the clock during render is impure, and the stamp must not
  // move when the component merely re-renders.
  const [stamp, setStamp] = useState<{ value: VideoProbeState | null; receivedAt: number }>({ value: null, receivedAt: 0 });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStamp({ value, receivedAt: performance.now() });
  }, [value]);
  // Until the effect has run for this frame it has been here no time at all:
  // an infinite receive time makes the list's held-for term clamp to zero.
  return { probe: value, receivedAt: stamp.value === value ? stamp.receivedAt : Number.POSITIVE_INFINITY };
}
