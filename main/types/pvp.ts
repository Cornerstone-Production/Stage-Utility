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

import type { RevisionedStatus } from "./live.js";

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
  /**
   * `playingItem.uuid`, or null.
   *
   * The KEY the next-cue lookup uses. Not the name: the live workspace carries
   * "CLEAR ALL" in three different playlists and "CLEAR GRAPHIC" twice inside
   * one, and all 26 entries have distinct uuids — so a name would resolve to
   * whichever copy the walk happened to reach first, and the "next" line under
   * it would name a cue from another part of the service.
   */
  lastCueUuid: string | null;
  /**
   * The playlist entry that FOLLOWS `lastCueUuid`, or null.
   *
   * Null covers three different unknowns on purpose — no cue, the last entry of
   * its playlist, and a cue the cached playlist tree has not heard of — because
   * the renderer does the same thing with all three: it draws no "next" line. A
   * line that is sometimes a guess is worse than no line.
   *
   * WHAT THIS IS NOT: it is not what PVP will play next. It is the next entry in
   * the playlist, which is what plays next only while the playlist keeps
   * auto-advancing. A hand-fired cue makes it wrong until the next poll. That is
   * why it is the quietest line on the widget and why it can be switched off.
   *
   * Filled by the SERVICE from a cached playlist read, not by parseWorkspace:
   * the transport-state response says nothing about playlists, and re-reading the
   * tree every poll to decorate one line would double the integration's traffic
   * for a value that changes when somebody edits a playlist.
   */
  nextCueName: string | null;
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

export interface PvpStatusDTO extends RevisionedStatus {
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
