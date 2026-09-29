// renderer/main/video/playback-stats.ts — turns a playing session's raw
// decoder counters into the deltas the presence heartbeat reports.
//
// A sampler is built once per playback ATTEMPT (use-video-session.ts creates
// one the moment its WebRTC/HLS session exists, alongside the <video> already
// on screen) and torn down when that attempt ends. That, not anything in
// here, is what keeps a WebRTC probe out of a report: a probe plays into an
// element nobody ever mounts and is never handed a sampler at all — this file
// has no notion of "probe" to get wrong.
//
// registerPlayback's `sample` (playback-reports.ts) is async even though
// nothing about the delta math needs to be: RTCPeerConnection.getStats() is
// unavoidably a Promise (the same shape probeWebrtc in use-video-session.ts
// already polls), and "getStats() rejected: skip this sample" only makes
// sense measured at the moment a report is actually built.

import type { VideoPlaybackReport } from "@main/types/video";

/** One ever-increasing counter, read across repeated calls as the delta since
 *  the last one. A value lower than the last reading is a fresh session's own
 *  counter restarting at (or near) zero, not negative frames — the delta for
 *  THAT call is 0, and the next call is measured from the new, lower
 *  baseline. */
export function trackDelta(): (current: number) => number {
  let last = 0;
  return (current: number) => {
    const delta = current >= last ? current - last : 0;
    last = current;
    return delta;
  };
}

interface RawCounts {
  decoded: number;
  dropped: number;
  width: number;
  height: number;
}

type StatsEntry = { type?: string; kind?: string; framesDecoded?: number; framesDropped?: number; frameWidth?: number; frameHeight?: number };

/** `pc.getStats()`'s one inbound-rtp video report. Null when `getStats()`
 *  itself rejects (most often a connection already closing) or carries no
 *  such report yet — either way the caller skips this sample rather than
 *  reporting zeros that are not really a reading. */
async function readWebrtcCounts(pc: RTCPeerConnection): Promise<RawCounts | null> {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }
  let found: RawCounts | null = null;
  report.forEach((r: StatsEntry) => {
    if (r.type === "inbound-rtp" && r.kind === "video") {
      found = { decoded: r.framesDecoded ?? 0, dropped: r.framesDropped ?? 0, width: r.frameWidth ?? 0, height: r.frameHeight ?? 0 };
    }
  });
  return found;
}

function readHlsCounts(video: HTMLVideoElement): RawCounts {
  const v = video as HTMLVideoElement & {
    getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
  };
  const q = v.getVideoPlaybackQuality?.();
  return { decoded: q?.totalVideoFrames ?? 0, dropped: q?.droppedVideoFrames ?? 0, width: video.videoWidth, height: video.videoHeight };
}

export interface PlaybackSampler {
  /** This attempt's current report — decoded/dropped/stalls as deltas since
   *  the last call, width/height as they stand now. Null when nothing could
   *  be read this time (`getStats()` rejected): the caller skips it rather
   *  than reporting zeros for a read that did not happen. */
  sample: () => Promise<VideoPlaybackReport | null>;
  /** Drops the `waiting` listener. Call once when the attempt this sampler
   *  belongs to ends — never left for garbage collection, since the <video>
   *  element it is attached to outlives any one attempt. */
  stop: () => void;
}

/**
 * One sampler for the session actually on screen. `pc` is required for
 * `via: "webrtc"` (its `inbound-rtp` report is the source of truth there —
 * `getVideoPlaybackQuality()` on an element playing a MediaStream is not) and
 * ignored for `via: "hls"`.
 *
 * Every counter starts at zero: a fresh sampler is built for every new
 * attempt, including a swap between methods (HLS handing over to an adopted
 * WebRTC session), so the first report after any swap is a delta against
 * zero, never against the session it replaced.
 */
export function createSampler(feedId: string, via: "webrtc" | "hls", video: HTMLVideoElement, pc?: RTCPeerConnection): PlaybackSampler {
  let stalls = 0;
  const onWaiting = () => {
    stalls += 1;
  };
  video.addEventListener("waiting", onWaiting);

  const decodedDelta = trackDelta();
  const droppedDelta = trackDelta();
  const stallsDelta = trackDelta();
  const read = (): Promise<RawCounts | null> => (via === "webrtc" ? readWebrtcCounts(pc!) : Promise.resolve(readHlsCounts(video)));

  return {
    sample: async () => {
      const raw = await read();
      if (!raw) return null;
      return {
        feedId,
        via,
        decoded: decodedDelta(raw.decoded),
        dropped: droppedDelta(raw.dropped),
        stalls: stallsDelta(stalls),
        width: raw.width,
        height: raw.height,
      };
    },
    stop: () => video.removeEventListener("waiting", onWaiting),
  };
}
