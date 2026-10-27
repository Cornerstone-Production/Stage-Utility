// main/types/video.ts — video feeds, the relay and what a screen plays.
//
// A feed is defined once and a layout's Video widget names it by id. The id is
// permanent; renaming changes only `name`, so a layout never loses its feed.

export const PUSH_PROTOCOLS = ["srt", "rtmp", "whip"] as const;
export type PushProtocol = (typeof PUSH_PROTOCOLS)[number];

/** How each push protocol is named on the page and in a feed's source line. */
export const PUSH_PROTOCOL_LABEL: Record<PushProtocol, string> = {
  srt: "SRT",
  rtmp: "RTMP",
  whip: "WHIP (OBS)",
};

/** What newPushPassword()'s kick attempt did, three ways rather than a
 *  boolean — "none" and "failed" are both "nothing got dropped," but only
 *  one of them means a device really was pushing and stayed connected
 *  under the old password: "dropped" a publisher was actually dropped; "none" nobody was
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

/** Whether the server converts a feed's audio so a browser can listen to it live.
 *  "auto" converts only AAC, which WebRTC cannot carry; "off" never runs ffmpeg
 *  for the feed; "always" converts whatever the audio is. */
export const AUDIO_CONVERSIONS = ["auto", "off", "always"] as const;
export type AudioConversion = (typeof AUDIO_CONVERSIONS)[number];

export interface VideoFeed {
  id: string;
  name: string;
  source: VideoSource;
  /** Only on a pull or push feed, and only when not "auto": absent means "auto". */
  audioConversion?: AudioConversion;
  /** An http or https address that carries the feed's audio in a form a browser
   *  can receive (Opus), for an encoder whose RTSP output does not. No
   *  username or password in it. Absent means the feed's own audio is used. */
  audioSourceUrl?: string;
}

/** LAN inputs (rtmp, srt, webrtcUdp) and loopback-only listeners (the rest). */
export interface VideoPorts {
  rtmp: number;
  srt: number;
  webrtcUdp: number;
  webrtcHttp: number;
  hls: number;
  api: number;
  /** The relay's RTSP listener, loopback only: where the server's own ffmpeg
   *  reads a feed and publishes its `-listen` path. Bound only when ffmpeg is
   *  usable. */
  rtsp: number;
}

export const DEFAULT_VIDEO_PORTS: VideoPorts = {
  rtmp: 1935,
  srt: 8890,
  webrtcUdp: 8189,
  webrtcHttp: 8889,
  hls: 8888,
  api: 9997,
  rtsp: 8554,
};

export interface VideoFeedsFile {
  feeds: VideoFeed[];
  ports: VideoPorts;
}

/** Whether this server has a usable ffmpeg (main/services/video/ffmpeg-system.ts),
 *  as a browser may see it: the version and where it was found as a class, or a
 *  reason that names no folder. `hint` is the install command for this platform.
 *  The folders stay in the server log. */
export type FfmpegStatus =
  | { ok: true; version: string; source: "automatic" | "homebrew" | "configured" }
  | { ok: false; reason: string; hint: string };

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

/** How long the relay holds a reader of a `-listen` path while its ffmpeg starts
 *  publishing (runOnDemandStartTimeout). Shared because the browser's handshake
 *  timeout for a listening session (use-video-session.ts) must outlast it: the
 *  WHEP POST is held that long on a cold start. */
export const LISTEN_START_TIMEOUT_MS = 15_000;

/** The same-origin playback addresses of a relay path (a feed's id, or its `-listen`
 *  sibling): where the proxy answers WHEP and HLS for it. */
export function relayPlayback(path: string): { whep: string; hls: string } {
  const base = `/video/${path}`;
  return { whep: `${base}/whep`, hls: `${base}/index.m3u8` };
}

/** How a screen plays a feed. Relay URLs are same-origin paths. */
export type FeedPlay =
  | { via: "relay"; whep: string; hls: string }
  | { via: "external"; url: string; protocol: "whep" | "hls" }
  | { via: "embed"; src: string };

/** What a feed's sound is, and where a listener should read it. `listenPath` is
 *  the relay path to play: the feed's own id, or its `-listen` sibling that holds
 *  the same video with Opus audio. */
export type FeedAudioStatus =
  /** The source has no audio. */
  | { state: "none" }
  /** Not seen yet, so what the audio is has not been learned. */
  | { state: "unknown" }
  /** Opus or G.711: a browser plays it as the relay has it. */
  | { state: "direct"; listenPath: string }
  /** Re-encoded to Opus by the server's ffmpeg, on demand. */
  | { state: "converted"; listenPath: string }
  /** Read from the feed's audio source address and republished unchanged. */
  | { state: "pass-through"; listenPath: string }
  /** Cannot be heard, and why, in a sentence the page shows as it is. */
  | { state: "unavailable"; reason: string };

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
  /** Only for a pull or push feed, the three below. The setting as resolved
   *  ("auto" when none is stored) and the address ("" when none). */
  audioConversion?: AudioConversion;
  audioSourceUrl?: string;
  audio?: FeedAudioStatus;
}

/**
 * One Video widget instance's playback health, carried in the presence
 * heartbeat's `video` field alongside every other instance currently showing
 * a picture — never one per feed: two widgets playing the same feed each
 * report their own numbers.
 *
 * `decoded`, `dropped` and `stalls` are deltas since the LAST report, not the
 * session's running total, so two heartbeats can be summed or charted without
 * re-deriving a rate from two cumulative reads — a counter that goes
 * backwards (a fresh session replacing the one being sampled) contributes a
 * zero delta rather than a negative one. `width`/`height` are the frame's
 * current size, never a delta.
 *
 * `jitterBufferMs` is the WebRTC-only receive-delay figure, in milliseconds,
 * measured over this report's interval: how long the average frame waited in
 * the browser's own jitter buffer. It says whether a lagging picture's delay
 * is held by the screen itself or lives upstream. Null when the browser could
 * not measure it (a WebRTC report without the needed stats); absent on an HLS
 * report, which never can, and on a report from a page older than the figure.
 * The server reads absent as null.
 */
export interface VideoPlaybackReport {
  feedId: string;
  via: "webrtc" | "hls";
  decoded: number;
  dropped: number;
  stalls: number;
  width: number;
  height: number;
  jitterBufferMs?: number | null;
}

/**
 * One (output, feed) pair's playback health over the last rolling minute —
 * computed server-side (main/services/video/playback-health.ts) from every
 * VideoPlaybackReport that pair has sent, and carried in VideoState.screens
 * so the Screens page can warn about a screen without asking the relay
 * itself anything: presence heartbeats already carry the numbers.
 *
 * One entry per (outputId, feedId), never per widget instance — two widgets
 * on one screen playing the same feed are folded into a single pair, the
 * same way `VideoPlaybackReport`'s own comment describes them arriving.
 */
export interface ScreenVideoHealth {
  outputId: string;
  feedId: string;
  via: "webrtc" | "hls";
  /** Sticky: set the moment the rolling window crosses a threshold, held for
   *  CLEAR_AFTER_MS after the last sample that kept it true — never a bare
   *  re-read of the instantaneous window fraction, which a later CLEAN
   *  sample's own decoded count would otherwise dilute back under threshold
   *  while the bad sample that caused it is still sitting in the window. */
  struggling: boolean;
  droppedInWindow: number;
  decodedInWindow: number;
  stallsInWindow: number;
  /** Sticky, like `struggling` and separate from it — a pair can be either,
   *  both or neither: the window's worst `jitterBufferMs` went over 1000 ms,
   *  held for CLEAR_AFTER_MS after the last sample that did. The screen's own
   *  browser is holding that much delay, so look at its network or decoding. */
  lagging: boolean;
  /** The worst `jitterBufferMs` any report in the window carried, or null when
   *  none carried one (HLS, or a browser that does not report it). A window
   *  figure, so as of the last re-read like the totals above. */
  jitterBufferMsInWindow: number | null;
  /** The frame's current size, as of the pair's last report — never a delta,
   *  same as VideoPlaybackReport's own width/height. */
  width: number;
  height: number;
  /** Epoch ms of this pair's last report. snapshot() drops a pair once
   *  `now - reportedAt >= WINDOW_MS`: nothing has reported it in a minute,
   *  so it is not read as "clean" — it is gone. */
  reportedAt: number;
  /**
   * The worst window this pair has had since `struggling` turned true —
   * same shape as the live `droppedInWindow`/`decodedInWindow`/
   * `stallsInWindow`/`width`/`height` fields above, but frozen at whichever
   * report made the window worst, not the live one. The live window's own
   * totals dilute as an old bad sample ages out from under a sticky flag
   * that is still holding it struggling — a card or log line built off the
   * live fields alone can end up describing a cause (stalls, say) that has
   * already aged out of what it is currently showing. `episode` is what a
   * screen's own card and the `[video]` struggling line read from instead.
   *
   * Null while not struggling, and cleared the instant the sticky flag
   * clears — see playback-health.ts's own comment on Pair.episode for how
   * "worst" is judged.
   */
  episode: {
    droppedInWindow: number;
    decodedInWindow: number;
    stallsInWindow: number;
    width: number;
    height: number;
  } | null;
  /**
   * The worst `jitterBufferMs` since `lagging` last turned true — what the card
   * and the `[video]` lagging line read, for the same reason `episode` exists:
   * the live window's figures age out from under a flag that is still holding.
   * Null while not lagging.
   */
  laggingEpisode: { jitterBufferMs: number } | null;
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
  /** Whether the pinned archive is already in video-relay/downloads (placed
   *  by hand, say), extracted or not — so the "off" line says the relay sets
   *  up from it rather than naming a download that will not happen. */
  archivePresent: boolean;
  feeds: VideoFeedView[];
  /** Every (output, feed) pair a presence heartbeat has reported playback
   *  for in the last rolling minute — struggling or not, so the feed list's
   *  "On N screens" can count every screen actually showing a feed, not only
   *  the struggling ones. See ScreenVideoHealth's own comment. */
  screens: ScreenVideoHealth[];
}

// ── Checking pulled feeds ───────────────────────────────────────────────────

/** What asking a pulled camera to describe its stream found. "checking" is the
 *  state before a feed's first answer since a page began watching; "unchecked"
 *  is a source that cannot be asked without streaming it (SRT). */
export interface VideoProbeEntry {
  state: "checking" | "ready" | "failed" | "unchecked";
  /** "H264", "H265" and so on, from the camera's own description. */
  codec?: string;
  width?: number;
  height?: number;
  /** An operator-readable sentence; only on "failed". */
  reason?: string;
  /** When the camera was last asked, ms since epoch. */
  checkedAt: number;
  /** When the current run of failed answers began; only on "failed". */
  since?: number;
  /** Only on "checking": the camera was reached but was busy answering
   *  another request, so no answer has come yet and the check is trying again. */
  busy?: true;
}

/** The `video:probe` channel: results by feed id. Only pulled feeds appear. */
export interface VideoProbeState {
  feeds: Record<string, VideoProbeEntry>;
  /** The server's clock when this snapshot was made, ms since epoch. With each
   *  entry's `checkedAt` it gives an age that does not depend on the viewer's
   *  clock: a wall display can be hours out. */
  at: number;
}

// ── Moving feeds between servers ────────────────────────────────────────────

/** The file `GET /api/video/export` writes and the import reads. Feeds keep
 *  their ids: a Video widget names its feed by id, so a moved view resolves
 *  only if the feed arrives under the same one. `password` and `ports` are
 *  present only when the export asked for them. */
export interface VideoFeedsBundle {
  kind: "stage-utility-video-feeds";
  version: 1;
  appVersion: string;
  createdAt: string;
  source: { server: string };
  feeds: { id: string; name: string; source: VideoSource; password?: string; audioConversion?: AudioConversion; audioSourceUrl?: string }[];
  ports?: VideoPorts;
}

export type ImportFeedStatus = "new" | "same" | "differs" | "invalid";

/** One field that differs between a file's feed and the one here. A password
 *  difference carries no values, ever. */
export interface FeedDifference {
  field: "name" | "kind" | "url" | "username" | "protocol" | "player" | "ref" | "password" | "audioConversion" | "audioSourceUrl";
  here?: string;
  file?: string;
}

export interface ImportFeedPreview {
  id: string;
  name: string;
  /** The file's source kind; whatever the file said when it is not one this build knows. */
  kind: string;
  status: ImportFeedStatus;
  differences: FeedDifference[];
  /** Set with "invalid": why this build cannot take the feed. */
  error?: string;
  /** Set when the file carries a password for this feed and the source kind can use one. */
  filePassword?: boolean;
  /** Fingerprint of this server's feed under the same id as the review saw it,
   *  "" when there was none. Hand it back in the import's `expect`. */
  here?: string;
}

export interface ImportPreview {
  server: string;
  createdAt: string;
  hasPasswords: boolean;
  feeds: ImportFeedPreview[];
  /** Names of feeds here that the file does not have. An import never removes them. */
  absent: string[];
  /** Only when the file carries ports. */
  ports?: { file: VideoPorts; here: VideoPorts; same: boolean };
}

export type ImportChoice = "replace" | "keep";

export interface ImportRequest {
  bundle: unknown;
  choices?: Record<string, ImportChoice>;
  /** The status each feed had in the review the operator saw. A feed that is
   *  not that any more is skipped, not written. */
  expect?: Record<string, string>;
  ports?: boolean;
}

export interface ImportReport {
  added: string[];
  /** The ids of the added feeds, for matching without relying on names. */
  addedIds: string[];
  replaced: string[];
  kept: string[];
  same: string[];
  skipped: { name: string; reason: string }[];
  /** Push feeds that got a freshly made publish password: their devices need it. */
  newPushPasswords: string[];
  /** Pull feeds replaced with an address on another camera (or a plain scheme
   *  where it was encrypted) and no password in the file: the one stored here
   *  was entered for the old address and is gone. */
  passwordsCleared: string[];
  passwordsWritten: number;
  portsApplied: boolean;
  /** Set when the ports were asked for and could not be saved; the feeds are already in. */
  portsError?: string;
}
