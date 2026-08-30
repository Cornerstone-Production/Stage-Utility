// pvp.ts — the shapes the ProVideoPlayer integration speaks.
//
// Every field here was observed live on 2026-08-29; see
// docs/superpowers/research/2026-08-29-provideoplayer.md. Fields that research
// could not observe are NOT here — a DTO field nothing ever fills is a renderer
// branch that is never exercised.
//
// `isPlaying` is deliberately absent even though PVP sends it. A still image
// reports isPlaying: true with playbackRate: 0, so it means "this layer is live",
// not "time is advancing" — and a field whose name says the opposite of what it
// means is one somebody will read wrongly. playbackRate answers the real question.

/**
 * What a layer is doing, as the UI actually needs it.
 *
 * "empty" is decided by the ABSENCE of `playingMedia`, not by any of the flags.
 * `playingItem` is residual — four idle layers were observed simultaneously
 * naming the same cue while showing nothing — so nothing about it can decide
 * whether a layer holds content.
 */
export type PvpLayerState = "empty" | "still" | "video";

export interface PvpLayerDTO {
  /** PVP's layer uuid. The diff key for every trigger and the address for every
   *  action. NOT the index: layer order is presentation, and an operator
   *  reordering layers would read as every layer changing at once. */
  uuid: string;
  /** The layer's own name, as PVP shows it. */
  name: string;
  /** Position in the workspace's layer stack, as PVP returns them. Display order
   *  only — nothing keys on it. */
  index: number;
  state: PvpLayerState;
  /** File name of the media on this layer, or null when the layer is empty. */
  mediaName: string | null;
  /**
   * Media uuid, or null when empty.
   *
   * The change key for "a cue started". Not the media NAME: the observed
   * workspace had seven files whose names differed only by a trailing digit, and
   * two cues in different playlists can point at the same file.
   */
  mediaUuid: string | null;
  /**
   * The LAST cue that touched this layer. Never "now playing".
   *
   * Kept raw, including on an empty layer where it is stale by definition,
   * because it is the only field that can confirm a trigger action landed. The
   * single place that decides whether to DRAW it is PvpLayerRow, which draws it
   * only when `state !== "empty"`.
   */
  lastCueName: string | null;
  hidden: boolean;
  muted: boolean;
  /** 0..1. PVP silently CLAMPS an out-of-range value it is sent rather than
   *  rejecting it, so this is clamped on read too and the two agree. */
  opacity: number;
  /** 0 for a still or a paused clip, > 0 while a video is rolling. */
  playbackRate: number;
  /**
   * `timeElapsed` at the moment of the sample, or null when there is nothing to
   * time. The ANCHOR the client interpolates from — deliberately excluded from
   * the change signature, so it rides only on frames that were being sent anyway.
   */
  anchorElapsedSec: number | null;
  /**
   * timeElapsed + timeRemaining, or null when nothing is rolling.
   *
   * Both halves are given, so a progress bar needs no duration lookup. Null for a
   * still, whose timeRemaining is 0 and whose "duration" would be a meaningless
   * echo of its elapsed.
   */
  durationSec: number | null;
}

export interface PvpStatusDTO {
  connected: boolean;
  layers: PvpLayerDTO[];
  /**
   * Server clock when this sample was taken (ISO), so a client can anchor the
   * progress bar and correct for its own drift.
   *
   * Excluded from the change signature for the reason live-poller.ts excludes
   * serverNow: it moves every tick, and re-pushing it every second is pure
   * overhead when the client can tick the number itself.
   */
  sampledAt: string | null;
}

export const PVP_OFFLINE: PvpStatusDTO = { connected: false, layers: [], sampledAt: null };

/**
 * Is this layer showing anything?
 *
 * The DTO's most important rule, given a name so it has ONE place to live. It is
 * decided by `state`, which parseWorkspace derived from the PRESENCE of the
 * `playingMedia` key — never from `isPlaying` (a still reports it true) and never
 * from `lastCueName` (residual; four idle layers were observed all naming the
 * same cue). Written out at each of its call sites, one of them would eventually
 * be written the other way.
 */
export const hasContent = (l: PvpLayerDTO): boolean => l.state !== "empty";
