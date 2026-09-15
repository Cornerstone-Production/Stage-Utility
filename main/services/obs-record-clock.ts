// obs-record-clock.ts — how far into a recording OBS is, computed from an anchor.
//
// The server does NOT push a frame per second. OBS's record timecode used to be
// polled at 1 Hz purely to refresh a "HH:MM:SS" string, and the service emitted
// whenever that string changed — one SSE frame to every connected browser, every
// second, for the whole length of a recording. Instead the DTO carries an ANCHOR
// (`recordAnchorMs` at `recordSampledAt`) and this file interpolates from it —
// exactly the trade pvp-progress.ts makes for a clip's progress bar, and
// pco-timer.ts for the countdown, and for the same reason.
//
// SHARED BY BOTH SIDES, which is the point of its own module rather than a pair
// of copies: the service folds a RecordStateChanged by re-anchoring to this
// instant, and every display reads the same formula forward. A second copy of
// "where is the recording now" is a second place for the two to disagree.
//
// PURE, and takes `now` rather than reading a clock, so every case is testable.

import type { ObsStatusDTO } from "../types/live.js";

/** As much of the OBS snapshot as the clock reads. */
export type RecordAnchor = Pick<
  ObsStatusDTO,
  "recording" | "recordPaused" | "recordAnchorMs" | "recordSampledAt"
>;

/**
 * Milliseconds recorded as of `at`, or null when there is nothing to time.
 *
 * Null rather than 0 for a recording with no anchor yet: 0 would draw 00:00:00
 * over a recording that has been rolling for an hour, which is the same lie the
 * Resi clock was fixed for. A widget showing no number is the honest answer for
 * the fraction of a second between the RecordStateChanged event and the
 * GetRecordStatus that answers it.
 *
 * A paused recording holds at the anchor. OBS stops advancing `outputDuration`
 * while paused, so counting wall-clock through a pause would report time that
 * was never recorded — `recordPaused` is this clock's `playbackRate`.
 *
 * No upper clamp, unlike a clip's progress: a recording has no duration to run
 * past. The lower clamp catches a `recordSampledAt` in the future, which is a
 * clock disagreement rather than a negative recording.
 */
export function recordElapsedMs(s: RecordAnchor, at: number): number | null {
  if (!s.recording || s.recordAnchorMs == null) return null;
  if (s.recordPaused) return Math.max(0, s.recordAnchorMs);
  const sampled = Date.parse(s.recordSampledAt ?? "");
  if (!Number.isFinite(sampled)) return null;
  return Math.max(0, s.recordAnchorMs + (at - sampled));
}

/** "HH:MM:SS", hours unpadded past 99 — the shape OBS's own timecode has, minus
 *  the milliseconds nobody reads off a wall. */
export function formatRecordTimecode(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * The record timecode a display shows right now, or null when there is none.
 *
 * `skewMs` is the server's clock minus this browser's, the same correction the
 * PCO countdown and the PVP progress bar apply — `recordSampledAt` is stamped by
 * the server, so a kiosk whose clock is a minute out would otherwise draw a
 * minute of recording that never happened.
 */
export function obsRecordTimecode(s: RecordAnchor | null, now: number, skewMs = 0): string | null {
  if (!s) return null;
  const ms = recordElapsedMs(s, now + skewMs);
  return ms == null ? null : formatRecordTimecode(ms);
}
