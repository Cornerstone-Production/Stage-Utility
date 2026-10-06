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
}

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
    };
  }
  const { default: Hls } = await loadHls();
  const hls = new Hls({ lowLatencyMode: true, backBufferLength: 10 });
  if (opts?.onFatal) {
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) opts.onFatal!(data.details ?? data.type);
    });
  }
  hls.loadSource(url);
  hls.attachMedia(video);
  return {
    stop() { hls.destroy(); },
    latencySeconds() { return typeof hls.latency === "number" && Number.isFinite(hls.latency) ? hls.latency : null; },
  };
}
