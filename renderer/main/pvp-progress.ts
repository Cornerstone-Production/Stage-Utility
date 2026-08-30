// pvp-progress.ts — where a PVP clip has got to, computed on the client.
//
// The server does NOT push a frame per second. timeElapsed and timeRemaining
// move every poll, so including either in the change comparison would turn a
// 1 Hz poll into a 1 Hz SSE frame to every display. Instead the DTO carries an
// ANCHOR (`anchorElapsedSec` at `sampledAt`) and this file interpolates from it —
// exactly the trade pco-timer.ts makes for the countdown, and for the same
// reason. The server re-anchors on a cue change, on drift past a second, and on
// a 15-second keepalive, so the guess here is never more than a second stale.
//
// PURE, and takes `now` rather than reading a clock, so every case is testable.

import type { PvpLayerDTO } from "@main/types/pvp";

export interface PvpProgress {
  /** Seconds into the clip, clamped to [0, durationSec]. */
  elapsedSec: number;
  /** Seconds left, clamped to [0, durationSec]. */
  remainingSec: number;
  durationSec: number;
  /** 0..1, for the bar. */
  fraction: number;
}

/**
 * Returns null when there is nothing to time — an empty layer, a still image, or
 * a sample whose timestamp will not parse.
 *
 * A still is null rather than 0-of-0 on purpose: PVP reports a still with
 * timeRemaining 0, so a bar drawn for it would sit permanently at either end and
 * read as a clip that had finished.
 */
export function computePvpProgress(
  layer: PvpLayerDTO,
  sampledAt: string | null,
  now: number,
  skewMs: number,
): PvpProgress | null {
  const duration = layer.durationSec;
  if (duration == null || duration <= 0) return null;
  if (layer.anchorElapsedSec == null) return null;

  const anchorMs = Date.parse(sampledAt ?? "");
  if (!Number.isFinite(anchorMs)) return null;

  // The server's clock, not this browser's. A kiosk whose clock is a minute out
  // would otherwise draw a minute of phantom progress on every frame.
  const serverNow = now + skewMs;
  const sinceAnchorSec = (serverNow - anchorMs) / 1000;

  // playbackRate is the multiplier PVP is actually running at, so a paused clip
  // (rate 0) holds where it was rather than creeping forward.
  const raw = layer.anchorElapsedSec + layer.playbackRate * sinceAnchorSec;
  // Clamped, because the anchor can be arbitrarily stale: a display that was
  // asleep through a keepalive must not draw a bar at 400% or a negative one.
  const elapsedSec = Math.min(duration, Math.max(0, raw));

  return {
    elapsedSec,
    remainingSec: duration - elapsedSec,
    durationSec: duration,
    fraction: elapsedSec / duration,
  };
}
