// pvp-parse.ts — one PVP workspace response folded into layer DTOs, plus the
// two questions the service asks about consecutive samples.
//
// PURE. No I/O and no clock: every function takes what it needs, so the whole
// file is testable against a saved fixture. The three findings encoded here were
// established by watching a live workspace over 702 samples, not by reading the
// vendor documentation — see docs/superpowers/research/2026-08-29-provideoplayer.md.

import type { PvpLayerDTO, PvpLayerState, PvpStatusDTO } from "../types/pvp.js";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A finite number, or the fallback. Never NaN, never Infinity. */
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Is this actually a PVP workspace response?
 *
 * `parseWorkspace` answers `[]` both for a workspace with no layers and for a
 * response that was never a workspace at all, and the caller has to be able to
 * tell those apart. It is not hypothetical: the setup mistake this integration
 * warns about twice is pointing at the port PVP serves its API DOCUMENTATION on,
 * which answers 200 with JSON — so without this, Test connection would report
 * "Connected — 0 layers" for the exact wrong port it exists to catch, and the
 * poll would sit reporting a healthy, idle PVP it had never parsed a word from.
 *
 * `{ data: [] }` is a real, empty workspace and passes.
 */
export function isWorkspaceResponse(json: unknown): boolean {
  return Array.isArray(rec(json).data);
}

/**
 * Fold `GET /api/0/transportState/workspace` into one DTO per layer.
 *
 * Degrades rather than throws. The response is 11.5 KB of nested objects from a
 * build we do not control, and a parser that threw would take the whole poll
 * down — reported to the operator as "unreachable", which would be a lie.
 *
 * Callers that need to distinguish "empty workspace" from "not a workspace" ask
 * isWorkspaceResponse FIRST; this one answers [] for both.
 */
export function parseWorkspace(json: unknown): PvpLayerDTO[] {
  const data = rec(json).data;
  if (!Array.isArray(data)) return [];

  const out: PvpLayerDTO[] = [];
  data.forEach((entry, index) => {
    const t = rec(rec(entry).transportState);
    const layer = rec(t.layer);
    const uuid = str(layer.uuid);
    // No uuid, no layer. It is the diff key for every trigger and the address for
    // every action; two layers keyed on "" would collide and read as one.
    if (!uuid) return;

    const media = rec(t.playingMedia);
    // PRESENCE of the key, not truthiness of the value. The key is absent — not
    // null — when a layer holds nothing, and this is the only reliable
    // has-content signal PVP gives. isPlaying is not it: a still image reports
    // isPlaying: true. playingItem is not it either: it is residual and never
    // clears, so four idle layers were observed all naming the same cue.
    const hasMedia = "playingMedia" in t;

    const playbackRate = num(t.playbackRate, 0);
    const elapsed = num(t.timeElapsed, 0);
    const remaining = num(t.timeRemaining, 0);

    // A still and a PAUSED CLIP both report playbackRate 0, and only
    // timeRemaining tells them apart: a still has none, a paused clip still has
    // the rest of itself to play. Reading rate alone called a paused clip a
    // still, which dropped its duration, which made its progress bar and its
    // countdown VANISH mid-service rather than freezing where they were.
    const timed = hasMedia && remaining > 0;
    const state: PvpLayerState = !hasMedia ? "empty" : playbackRate > 0 || timed ? "video" : "still";

    out.push({
      uuid,
      name: str(layer.name) ?? uuid,
      index,
      state,
      mediaName: hasMedia ? str(media.name) : null,
      mediaUuid: hasMedia ? str(media.uuid) : null,
      // Raw, including on an empty layer where it is stale by definition. It is
      // the only field that can confirm a trigger action landed; PvpLayerRow is
      // the single place that decides whether to draw it.
      lastCueName: str(rec(t.playingItem).name),
      hidden: layer.isHidden === true,
      muted: layer.isMuted === true,
      // Absent means fully opaque. Defaulting to 0 would render every layer of a
      // build that omits the field invisible.
      opacity: clamp01(num(layer.opacity, 1)),
      playbackRate,
      anchorElapsedSec: state === "empty" ? null : elapsed,
      // A still reports timeRemaining 0, so its "duration" would be a meaningless
      // echo of its elapsed. Keyed on the remaining time rather than on the rate,
      // so a PAUSED clip keeps its bar instead of losing it the moment it stops.
      durationSec: timed ? elapsed + remaining : null,
    });
  });
  return out;
}

/**
 * Everything a client REACTS to, as a string.
 *
 * The efficiency decision lives here. `anchorElapsedSec`, `durationSec` and
 * `sampledAt` are deliberately absent: they move on every poll during playback,
 * and including any of them would turn a 1 Hz poll into a 1 Hz SSE frame to
 * every connected display. The client ticks the progress bar itself from the
 * anchor plus its own clock — the same trade live-poller.ts makes for
 * serverNow, for the same reason.
 *
 * A string rather than a field-by-field compare because the payload is an ARRAY:
 * StatusIntegration.emitIfChanged compares keys with `!==`, and a fresh array is
 * never `===` its predecessor, so the base implementation would broadcast every
 * poll however few fields actually changed.
 *
 * `mediaName` is out too, but for a different reason: the uuid beside it is the
 * identity, and a name change under a stable uuid is a relabel, not a cue.
 */
export function layerSignature(layers: readonly PvpLayerDTO[]): string {
  return JSON.stringify(
    layers.map((l) => [
      l.uuid, l.name, l.index, l.state, l.mediaUuid, l.lastCueName,
      l.hidden, l.muted, l.opacity, l.playbackRate,
    ]),
  );
}

/**
 * How far the progress clock has moved away from what the last anchor predicted.
 *
 * The client interpolates between frames, so between frames it is guessing. This
 * bounds the guess: predict where `timeElapsed` should be by now and compare
 * with what PVP actually reports.
 *
 * The case this exists for is a single clip LOOPING. Its media uuid never
 * changes, so the signature never changes, and without this the bar would sit at
 * 100% until the keepalive — predicted 20.5, observed 0.3 on the first poll past
 * the loop point.
 *
 * Returns 0 rather than NaN whenever either side has no anchor, so a layer that
 * just gained or lost content cannot force a frame on every poll thereafter.
 */
export function anchorDriftSec(
  prevElapsedSec: number | null,
  prevAtMs: number,
  nextElapsedSec: number | null,
  nextAtMs: number,
  playbackRate: number,
): number {
  if (prevElapsedSec == null || nextElapsedSec == null) return 0;
  const dtSec = (nextAtMs - prevAtMs) / 1000;
  if (!Number.isFinite(dtSec) || dtSec < 0) return 0;
  const predicted = prevElapsedSec + playbackRate * dtSec;
  const drift = Math.abs(nextElapsedSec - predicted);
  return Number.isFinite(drift) ? drift : 0;
}

/**
 * Which layers need a fresh anchor sent, by uuid.
 *
 * A layer absent from `prev` is NOT drift — it is a signature change, which is
 * already a reason to broadcast, and reporting it twice would be noise.
 */
export function driftedLayers(
  prev: PvpStatusDTO,
  next: PvpStatusDTO,
  toleranceSec: number,
): string[] {
  const prevAtMs = Date.parse(prev.sampledAt ?? "");
  const nextAtMs = Date.parse(next.sampledAt ?? "");
  // No usable pair of timestamps, no prediction — and never a frame every poll.
  if (!Number.isFinite(prevAtMs) || !Number.isFinite(nextAtMs)) return [];

  const before = new Map(prev.layers.map((l) => [l.uuid, l]));
  const out: string[] = [];
  for (const l of next.layers) {
    const b = before.get(l.uuid);
    if (!b) continue;
    if (anchorDriftSec(b.anchorElapsedSec, prevAtMs, l.anchorElapsedSec, nextAtMs, b.playbackRate) > toleranceSec) {
      out.push(l.uuid);
    }
  }
  return out;
}
