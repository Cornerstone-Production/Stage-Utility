// main/types/video.ts — video feeds, the relay and what a screen plays.
//
// A feed is defined once and a layout's Video widget names it by id. The id is
// permanent; renaming changes only `name`, so a layout never loses its feed.

export const PUSH_PROTOCOLS = ["srt", "rtmp", "whip"] as const;
export type PushProtocol = (typeof PUSH_PROTOCOLS)[number];

export const EMBED_PLAYERS = ["youtube-channel", "youtube-video", "resi"] as const;
export type EmbedPlayer = (typeof EMBED_PLAYERS)[number];

/** Where a feed's picture comes from. Passwords are never here: they live in
 *  secretsStore under `video:<feedId>`, so a config snapshot never carries one. */
export type VideoSource =
  /** The relay fetches it, only while something watches. `url` has no userinfo. */
  | { kind: "pull"; url: string; username: string }
  /** The device connects to the relay with the feed's password. */
  | { kind: "push"; protocol: PushProtocol }
  /** The platform's own iframe player. `ref` is a channel id, video id or Resi URL. */
  | { kind: "embed"; player: EmbedPlayer; ref: string }
  /** Something else already serves WHEP or HLS; screens play it as given. */
  | { kind: "external"; url: string };

export type VideoSourceKind = VideoSource["kind"];

export interface VideoFeed {
  id: string;
  name: string;
  source: VideoSource;
}

/** LAN inputs (rtmp, srt, webrtcUdp) and loopback-only listeners (the rest). */
export interface VideoPorts {
  rtmp: number;
  srt: number;
  webrtcUdp: number;
  webrtcHttp: number;
  hls: number;
  api: number;
}

export const DEFAULT_VIDEO_PORTS: VideoPorts = {
  rtmp: 1935,
  srt: 8890,
  webrtcUdp: 8189,
  webrtcHttp: 8889,
  hls: 8888,
  api: 9997,
};

export interface VideoFeedsFile {
  feeds: VideoFeed[];
  ports: VideoPorts;
}

/** null state: an external feed, which Stage Utility cannot see. */
export type FeedState = "live" | "delayed" | "standby" | "waiting" | "offline" | "embed";

export interface FeedStatus {
  state: FeedState | null;
  /** Set with "delayed": why WebRTC cannot carry it. */
  delayedBecause?: "b-frames" | "codec";
  codec?: string;
  width?: number;
  height?: number;
  profile?: string;
  /** Epoch ms the feed was last live; set with "offline". */
  lastSeenAt?: number | null;
}

/** How a screen plays a feed. Relay URLs are same-origin paths. */
export type FeedPlay =
  | { via: "relay"; whep: string; hls: string }
  | { via: "external"; url: string; protocol: "whep" | "hls" }
  | { via: "embed"; src: string };

/** A feed as the wire carries it: no secrets, ever. */
export interface VideoFeedView {
  id: string;
  name: string;
  kind: VideoSourceKind;
  /** One line for the page's list: the kind, then the address, protocol or
   *  embed reference, e.g. "Pulled from a device · rtsp://192.0.2.21:8554/stream2". */
  sourceLine: string;
  source: VideoSource;
  play: FeedPlay;
  status: FeedStatus;
  /** Set only for a pull feed: whether a password is CURRENTLY stored for
   *  it — never the value. The editor uses this to say "a password is
   *  saved" without a blank field implying there is none. */
  hasPassword?: boolean;
}

export type RelayStatus =
  | { state: "off" }
  | { state: "downloading"; receivedBytes: number; totalBytes: number }
  /** `version` is null only if no process has EVER printed a startup banner
   *  — once one has, it never resets, surviving every later restart. A
   *  "starting" supervisor has no live child at all yet (one is not spawned
   *  until AFTER "starting"), so a non-null version here describes a
   *  PREVIOUS run, never proof that the current attempt has printed
   *  anything. */
  | { state: "starting"; version: string | null }
  | { state: "running"; version: string; ports: VideoPorts }
  | { state: "failing"; reason: string; retryAt: number | null; placeArchiveAt?: string };

export interface VideoState {
  rev: number;
  relay: RelayStatus;
  /** The Source kinds this build offers; the page's dropdown lists exactly these. */
  kinds: VideoSourceKind[];
  feeds: VideoFeedView[];
}
