// renderer/main/video/hls-player.ts — hls.js wherever Media Source Extensions
// exist, native HLS only where they do not (older iOS), hls.js imported only
// when a feed needs it.
//
// hls.js first, not native first: Chrome now answers canPlayType for HLS with
// "maybe", and its native player fails on the relay's low-latency HLS (one
// frame, then a demuxer error) where hls.js plays the same playlist in the
// same browser. Safari has MSE too, so it takes hls.js as well.

import { mseAvailable } from "./choose-playback";

export interface HlsSession {
  stop: () => void;
  /** Seconds behind the live edge, for the "N s behind" badge. */
  latencySeconds: () => number | null;
  /** Jumps back to live when playback has fallen more than LIVE_JUMP_MARGIN_S
   *  behind where hls.js aims to sit. Returns the seconds skipped, or null
   *  when it did nothing. Called once a second; never jumps while paused.
   *  Native HLS never jumps: it picks its own distance from live and does not
   *  say what it is, and a guess that sits short of it would jump every
   *  cooldown, holding the picture each time. */
  catchUp: () => number | null;
}

/** How far past its target latency a feed may fall before it jumps back to
 *  live. A stall (the source hiccupping, the relay reconnecting) resumes
 *  where it stopped, and nothing in hls.js's defaults ever wins that time
 *  back: its playback-rate catch-up is off, and it treats anything more than
 *  one segment past target as deliberate DVR viewing. */
export const LIVE_JUMP_MARGIN_S = 2;
/** At most one jump this often. A jump lands where nothing is buffered yet,
 *  so the picture holds for a moment while it loads; a feed that keeps
 *  falling behind must not hold every second. */
export const LIVE_JUMP_COOLDOWN_MS = 10_000;
/** hls.js speeds playback up to this, never faster, while it is less than one
 *  segment past its target with over a second buffered — the small gaps a
 *  jump would be too heavy for. The <video> is muted, so the only tell is
 *  motion briefly a little quick. */
export const MAX_LIVE_SYNC_RATE = 1.25;

type HlsModule = typeof import("hls.js");
const importHls = (): Promise<HlsModule> => import("hls.js");
let loadHls = importHls;

/** Tests hand in a stand-in for hls.js, which under Node has no MediaSource
 *  to attach to; null puts the real import back. */
export function __setHlsLoaderForTests(load: (() => Promise<HlsModule>) | null): void {
  loadHls = load ?? importHls;
}

/** `onFatal`: a fatal hls.js error (`Hls.Events.ERROR` with `data.fatal`),
 *  reported so the widget can show Offline and retry with its backoff. Native
 *  HLS has no such event — a native failure surfaces as the `<video>` element's
 *  own `error` event, which the widget already listens for directly. */
export async function startHls(
  url: string,
  video: HTMLVideoElement,
  opts?: { onFatal?: (why: string) => void },
): Promise<HlsSession> {
  if (!mseAvailable()) {
    video.src = url;
    return {
      stop() { video.removeAttribute("src"); video.load(); },
      latencySeconds() {
        const r = video.seekable;
        return r.length ? Math.max(0, r.end(r.length - 1) - video.currentTime) : null;
      },
      catchUp: () => null,
    };
  }
  const { default: Hls } = await loadHls();
  const hls = new Hls({ lowLatencyMode: true, backBufferLength: 10, maxLiveSyncPlaybackRate: MAX_LIVE_SYNC_RATE });
  if (opts?.onFatal) {
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) opts.onFatal!(data.details ?? data.type);
    });
  }
  hls.loadSource(url);
  hls.attachMedia(video);
  const latencySeconds = () => (typeof hls.latency === "number" && Number.isFinite(hls.latency) ? hls.latency : null);
  let lastJumpAt = -Infinity;
  return {
    stop() { hls.destroy(); },
    latencySeconds,
    catchUp() {
      // Paused, the gap grows by design and a jump would only spend the
      // cooldown before play resumes and needs it.
      const latency = latencySeconds();
      const { targetLatency, liveSyncPosition } = hls;
      if (video.paused || latency === null || targetLatency === null || liveSyncPosition === null) return null;
      if (latency - targetLatency <= LIVE_JUMP_MARGIN_S) return null;
      const now = Date.now();
      if (now - lastJumpAt < LIVE_JUMP_COOLDOWN_MS) return null;
      // Through a long source stall the latency keeps growing while the
      // playlist stands still, and the sync position can sit BEHIND the
      // stuck playhead: a "jump" there would replay video.
      const skipped = liveSyncPosition - video.currentTime;
      if (skipped <= 0) return null;
      lastJumpAt = now;
      video.currentTime = liveSyncPosition;
      return skipped;
    },
  };
}
