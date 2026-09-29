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

import { errorMessage } from "@main/services/errors";
import { OutageLog } from "@main/services/repeat-log";
import type { VideoPlaybackReport } from "@main/types/video";

/** How long one stats read may take before it counts as a failed read. Under
 *  the presence heartbeat's own limit on the whole drain (DRAIN_TIMEOUT_MS in
 *  playback-reports.ts), so one widget whose getStats() hangs is left out on
 *  its own, and logged, rather than taking every widget's report with it. */
export const STATS_READ_TIMEOUT_MS = 1_500;

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
  /** WebRTC only, and only when the browser reports one — Chrome's
   *  `inbound-rtp` video report carries a receiver-side freeze count;
   *  `readHlsCounts` never sets this. Undefined, never 0, when the report
   *  carries no such field at all: on a session's first report,
   *  `createSampler` reads that as "this browser does not report freezes"
   *  and counts `waiting` events instead, which a genuine zero-freezes
   *  reading must not be confused with. */
  freezeCount?: number;
}

type StatsEntry = {
  type?: string;
  kind?: string;
  framesDecoded?: number;
  framesDropped?: number;
  frameWidth?: number;
  frameHeight?: number;
  freezeCount?: number;
};

/** `pc.getStats()`'s one inbound-rtp video report, or null when the call
 *  succeeded but carries no such report yet — legitimately nothing to
 *  report, never logged (see `createSampler`). Rethrows a `getStats()`
 *  failure itself: the caller, not this function, knows whether that is
 *  teardown noise or a real outage worth telling the operator about. */
/** `read`, or a rejection once STATS_READ_TIMEOUT_MS passes without it. A
 *  result landing after that is dropped: the next read's deltas count what
 *  this one missed. */
async function inTime<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`getStats() did not answer within ${STATS_READ_TIMEOUT_MS / 1000} s`)), STATS_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function readWebrtcCounts(pc: RTCPeerConnection): Promise<RawCounts | null> {
  const report = await pc.getStats();
  let found: RawCounts | null = null;
  report.forEach((r: StatsEntry) => {
    if (r.type === "inbound-rtp" && r.kind === "video") {
      found = { decoded: r.framesDecoded ?? 0, dropped: r.framesDropped ?? 0, width: r.frameWidth ?? 0, height: r.frameHeight ?? 0, freezeCount: r.freezeCount };
    }
  });
  return found;
}

/** `decoded` is `totalVideoFrames` less `droppedVideoFrames`: the total counts
 *  every frame the element received, dropped ones included, where WebRTC's
 *  `framesDecoded` does not. Subtracting here makes `dropped / decoded` mean
 *  the same on both, which the server's 5% line assumes. */
function readHlsCounts(video: HTMLVideoElement): RawCounts {
  const v = video as HTMLVideoElement & {
    getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
  };
  const q = v.getVideoPlaybackQuality?.();
  const total = q?.totalVideoFrames ?? 0;
  const dropped = q?.droppedVideoFrames ?? 0;
  return { decoded: total - dropped, dropped, width: video.videoWidth, height: video.videoHeight };
}

/** What a sampler reads from — `pc` only exists on the `webrtc` arm, so the
 *  type checker enforces "every webrtc caller has one," rather than
 *  `createSampler` asserting it at runtime with a `pc!`. */
export type SampleSource = { via: "webrtc"; pc: RTCPeerConnection } | { via: "hls" };

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
 * One sampler for the session actually on screen. `source.pc` is what
 * `via: "webrtc"` reads from (its `inbound-rtp` report is the source of
 * truth there — `getVideoPlaybackQuality()` on an element playing a
 * MediaStream is not); `via: "hls"` reads `video` directly and carries no
 * `pc` at all.
 *
 * Every counter starts at zero: a fresh sampler is built for every new
 * attempt, including a swap between methods (HLS handing over to an adopted
 * WebRTC session), so the first report after any swap is a delta against
 * zero, never against the session it replaced. For an adopted WebRTC
 * session specifically, that first delta is everything decoded since the
 * PROBE's own session started, not since the swap — bounded by the probe's
 * own adoption poll (`PROBE_POLL_MS` in use-video-session.ts), so in
 * practice on the order of one poll interval's worth of frames.
 *
 * `onLog` hears about `getStats()` itself rejecting — a DIFFERENT problem
 * from "no inbound-rtp report yet" (legitimately silent, see
 * `readWebrtcCounts`) or from a dropped PICTURE (`use-video-session.ts`'s own
 * `OutageLog`-backed streak, keyed on the feed, for `onDropped`/
 * `onWebrtcUnusable`). This sampler gets its OWN `OutageLog`, not a share of
 * that one: the two are orthogonal (stats can fail to read while the picture
 * plays perfectly, or vice versa), and a shared run's settle window would
 * have a live picture's stats failure wait out an unrelated playback drop
 * before ever announcing recovery. Scoped to THIS sampler's own lifetime —
 * exactly like every other counter here, a fresh attempt's fresh sampler
 * starts a fresh run, never carrying a prior attempt's outage forward.
 */
export function createSampler(
  feedId: string,
  name: string,
  source: SampleSource,
  video: HTMLVideoElement,
  onLog: (reason: string) => void,
): PlaybackSampler {
  let stopped = false;
  let stalls = 0;
  const onWaiting = () => {
    stalls += 1;
  };
  video.addEventListener("waiting", onWaiting);

  const decodedDelta = trackDelta();
  const droppedDelta = trackDelta();
  // `waiting`-event count, as a delta — the only source on HLS, and
  // WebRTC's own fallback when this browser reports no freezeCount at all.
  const stallsDelta = trackDelta();
  // WebRTC's own freeze-count delta, kept separate from stallsDelta above:
  // the two count different underlying events (a receiver-side freeze vs a
  // `waiting` DOM event) and must never be summed or swapped mid-session.
  const freezeCountDelta = trackDelta();
  // Which of the two this session's stalls come from. HLS is always
  // `waiting`. WebRTC latches on the first sample that carries an
  // inbound-rtp video report: freezeCount if that report has one, `waiting`
  // otherwise, for the rest of the session whatever later reports carry.
  let stallSource: "freezeCount" | "waiting" | null = source.via === "hls" ? "waiting" : null;
  const statsOutage = new OutageLog();
  const read = (): Promise<RawCounts | null> => (source.via === "webrtc" ? inTime(readWebrtcCounts(source.pc)) : Promise.resolve(readHlsCounts(video)));

  return {
    sample: async () => {
      let raw: RawCounts | null;
      try {
        raw = await read();
      } catch (err) {
        // Stopped between the call going out and its rejection landing: the
        // session is closing on purpose, and `getStats()` failing on a
        // closed/closing RTCPeerConnection is the expected shape of that,
        // not an outage worth telling the operator about.
        if (!stopped) {
          const d = statsOutage.fail("", errorMessage(err), Date.now());
          if (d.log) onLog(`${name}: could not read playback stats: ${errorMessage(err)}${d.note}`);
        }
        return null;
      }
      // A read that lands after stop() belongs to an attempt that has ended:
      // its recovery is not this widget's news either.
      if (!stopped) {
        const d = statsOutage.ok("", Date.now());
        if (d.log) onLog(`${name}: playback stats readable again${d.note}`);
      }
      if (!raw) return null;
      // A `<video>` playing a MediaStream (WebRTC) never fires `waiting`
      // when the stream starves, so Chrome's own receiver-side freeze count
      // is the real source of stalls there; `waiting` is the fallback for a
      // browser whose `inbound-rtp` report carries none. A later report
      // missing freezeCount on a freezeCount session reads as no stalls,
      // leaving the tracker's baseline where the last reading put it.
      stallSource ??= raw.freezeCount !== undefined ? "freezeCount" : "waiting";
      const stallCount =
        stallSource === "waiting" ? stallsDelta(stalls) : raw.freezeCount === undefined ? 0 : freezeCountDelta(raw.freezeCount);
      return {
        feedId,
        via: source.via,
        decoded: decodedDelta(raw.decoded),
        dropped: droppedDelta(raw.dropped),
        stalls: stallCount,
        width: raw.width,
        height: raw.height,
      };
    },
    stop: () => {
      stopped = true;
      video.removeEventListener("waiting", onWaiting);
    },
  };
}
