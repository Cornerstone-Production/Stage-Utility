// renderer/main/video/choose-playback.ts — which way this screen plays a feed.
//
// WebRTC first: under a second behind. HLS when WebRTC cannot carry the stream
// (B-frames), is missing, or failed here; 2 to 6 s behind, so the widget badges
// it. The embed player for YouTube and Resi. Otherwise this screen cannot play it.

import type { FeedPlay, FeedStatus } from "@main/types/video";

export interface PlaybackInput {
  play: FeedPlay;
  status: FeedStatus;
  caps: { webrtc: boolean; nativeHls: boolean; mse: boolean };
  /** The screen's "Use HLS on this screen" switch; true where it is not set. */
  allowHls: boolean;
  /** WebRTC connected but showed no frame, or did not connect, on this screen. */
  webrtcFailed: boolean;
}

export type PlaybackChoice =
  | { method: "webrtc"; url: string }
  | { method: "hls"; url: string }
  | { method: "embed"; url: string }
  | { method: "none"; reason: "hls-off-here" | "no-player" };

export function choosePlayback(i: PlaybackInput): PlaybackChoice {
  const p = i.play;
  if (p.via === "embed") return { method: "embed", url: p.src };
  const canHls = i.caps.nativeHls || i.caps.mse;
  const hls = (url: string): PlaybackChoice =>
    !i.allowHls ? { method: "none", reason: "hls-off-here" } : canHls ? { method: "hls", url } : { method: "none", reason: "no-player" };

  if (p.via === "external") {
    if (p.protocol === "hls") return hls(p.url);
    return i.caps.webrtc && !i.webrtcFailed ? { method: "webrtc", url: p.url } : { method: "none", reason: "no-player" };
  }
  const webrtcOk = i.caps.webrtc && !i.webrtcFailed && i.status.delayedBecause !== "b-frames";
  return webrtcOk ? { method: "webrtc", url: p.whep } : hls(p.hls);
}

/**
 * Media Source Extensions in either form: `MediaSource`, or `ManagedMediaSource`,
 * which is all an iPhone on iOS 17.1 or later has. hls.js uses whichever exists,
 * so either one means hls.js can play here.
 */
export function mseAvailable(): boolean {
  const g = globalThis as { MediaSource?: unknown; ManagedMediaSource?: unknown };
  return typeof g.MediaSource === "function" || typeof g.ManagedMediaSource === "function";
}

export function browserCaps(): PlaybackInput["caps"] {
  const v = document.createElement("video");
  return {
    webrtc: typeof RTCPeerConnection === "function",
    nativeHls: v.canPlayType("application/vnd.apple.mpegurl") !== "",
    mse: mseAvailable(),
  };
}
