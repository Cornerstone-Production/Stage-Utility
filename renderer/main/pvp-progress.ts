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

/**
 * WHICH clip a progress fraction is a fraction of.
 *
 * The progress rule interpolates between consecutive readings, and that is only
 * honest for two readings of the same thing — so it snaps when this changes. See
 * readout-meter.tsx.
 *
 * The layer as well as the media: a widget with no layer named follows content
 * and can move to another layer that happens to be holding the same file, which
 * is a cut and not a tick. Falls back to the media NAME where PVP gives no uuid,
 * and to the layer alone where it gives neither — a rule with nothing to key on
 * still snaps on the fraction's own discontinuities.
 *
 * Here rather than in either widget: both the "now" readout and the layer list
 * draw this rule, and a key that meant something different in the two of them
 * would be two behaviours wearing one name.
 */
export function pvpMeterKey(layer: PvpLayerDTO | null): string | null {
  return layer ? `${layer.uuid} ${layer.mediaUuid ?? layer.mediaName ?? ""}` : null;
}

/**
 * The first two rungs of "why is there nothing to show", shared by both widgets.
 *
 * `null` status is NO SNAPSHOT YET, not "PVP is down" — the distinction the whole
 * ladder exists to preserve. It lasts only until the first hydrate, and an
 * unconfigured PVP hydrates to connected:false, so it does not linger.
 *
 * Here, beside pvpMeterKey, rather than in either widget: pvp-now and pvp-object
 * each wrote out the same two answers before diverging on the third, and a
 * wording change to "ProVideoPlayer offline" that landed in one of them would
 * put two names for one machine on one wall. Each widget's own test still pins
 * its full ladder, so a divergence goes red rather than silent — but a shared
 * prefix cannot diverge in the first place.
 *
 * @returns the sentence, or null when the answer is further down the widget's
 *   own ladder.
 */
export function pvpUnavailableReason(status: { connected: boolean } | null): string | null {
  if (!status) return "—";
  if (!status.connected) return "ProVideoPlayer offline";
  return null;
}

/** "No layer named X" — the same sentence in both widgets, for the same case:
 *  the layout names a layer PVP is not reporting. */
export function noSuchLayer(layerName: string): string {
  return `No layer named ${layerName}`;
}
