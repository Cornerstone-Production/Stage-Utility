// renderer/main/video/hls-player.ts — native HLS where the browser has it
// (Safari, iPad), hls.js elsewhere, imported only when a feed needs it.

export interface HlsSession {
  stop: () => void;
  /** Seconds behind the live edge, for the "N s behind" badge. */
  latencySeconds: () => number | null;
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
  if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
    video.src = url;
    return {
      stop() { video.removeAttribute("src"); video.load(); },
      latencySeconds() {
        const r = video.seekable;
        return r.length ? Math.max(0, r.end(r.length - 1) - video.currentTime) : null;
      },
    };
  }
  const { default: Hls } = await import("hls.js");
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
