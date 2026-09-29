// main/types/video.ts — video feeds, the relay and what a screen plays.
//
// A feed is defined once and a layout's Video widget names it by id. The id is
// permanent; renaming changes only `name`, so a layout never loses its feed.

export const PUSH_PROTOCOLS = ["srt", "rtmp", "whip"] as const;
export type PushProtocol = (typeof PUSH_PROTOCOLS)[number];

/** What newPushPassword()'s kick attempt did, three ways rather than a
 *  boolean — "none" and "failed" are both "nothing got dropped," but only
 *  one of them means a device really was pushing and stayed connected
 *  under the old password (controller ruling on R14d's own flagged wording
 *  gap): "dropped" a publisher was actually dropped; "none" nobody was
 *  publishing, or no relay is running to ask; "failed" a publisher WAS
 *  there and the attempt to drop it failed. */
export type KickResult = "dropped" | "none" | "failed";

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

/**
 * Which failing case this is — separate from `reason` (free text an operator
 * reads) because two different UI/logic decisions turn on knowing the CASE,
 * not the words:
 *
 * - "Change ports in Advanced" only helps a `port-conflict`; showing it for
 *   an unsupported platform or a download failure sends the operator to a
 *   page with nothing to fix.
 * - A pull/push feed reads "offline" rather than "standby" only once a relay
 *   PROCESS has actually run in this outage — true for `crash-loop` (a child
 *   ran and exited) and `not-answering` (one is running; its API just is
 *   not), never for the other five, all raised before any child exists at
 *   all (relay-lifecycle.ts's own pre-supervisor sequence never gets far
 *   enough to have spawned anything a source could have reached).
 *
 * `unsupported` is the one kind that never retries (no pinned asset exists
 * for this platform/arch, ever) — `retryAt` is always null for it.
 */
export type RelayFailureKind =
  | "port-conflict"
  | "download"
  | "config-write"
  | "spawn"
  | "unsupported"
  | "crash-loop"
  | "not-answering";

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
  /** `placeArchiveAt` is the downloads folder relative to the data folder
   *  ("video-relay/downloads"), never the full path: any LAN client reads
   *  this, and the server log has the full one.
   *  `assetName` is set only once a real pinned asset exists to place —
   *  never for "no asset for this platform/arch at all" (acquire.ts's
   *  `ensureBinary` says which case it is directly, rather than a caller
   *  guessing from whether `placeArchiveAt` looks like a bare directory or a
   *  full file path). The renderer never derives it by splitting
   *  `placeArchiveAt` on "/" — that breaks on Windows. */
  | {
      state: "failing";
      reason: string;
      kind: RelayFailureKind;
      retryAt: number | null;
      placeArchiveAt?: string;
      assetName?: string;
    };

export interface VideoState {
  rev: number;
  relay: RelayStatus;
  /** The Source kinds this build offers; the page's dropdown lists exactly these. */
  kinds: VideoSourceKind[];
  /** The STORED ports — what the next start (or restart) will use, and what
   *  the Advanced page's ports card edits. Independent of `relay`: a running
   *  relay's OWN ports (relay.state === "running" ? relay.ports : never) can
   *  differ from this for the moment between a ports save and the restart it
   *  triggers, which is exactly why the two are separate fields rather than
   *  one "ports" the running state alone carries. */
  ports: VideoPorts;
  /** Whether the pinned MediaMTX binary is already extracted on this
   *  machine — from relayDir's own versioned binary existing, checked fresh
   *  on every read. Lets the "off" status line tell "never downloaded" (show
   *  the download-size sentence) from "downloaded once, just switched off
   *  since" (say nothing) apart — `relay.state` alone cannot: both read
   *  "off". */
  binaryPresent: boolean;
  feeds: VideoFeedView[];
}
