// renderer/main/video/playback-reports.ts — the per-widget registry the
// screen's presence heartbeat drains.
//
// A Video widget instance calls registerPlayback once it is actually showing
// a relay or external feed's picture (never an embed, whose playback Stage
// Utility cannot measure at all), and calls the returned unregister function
// the moment it stops — on unmount, or when the picture it was showing goes
// away. Keyed by WIDGET INSTANCE, not by feed: two widgets playing the same
// feed are two keys, two samples, two reports.

import type { VideoPlaybackReport } from "@main/types/video";

/** How often the presence heartbeat fires while at least one widget is
 *  registered here — faster than either of its normal near/far cadences
 *  (stage-view.tsx), since a stalled or dropped picture is worth knowing
 *  about sooner than a screen merely being present. */
export const VIDEO_HEARTBEAT_MS = 10_000;

type Sample = () => Promise<VideoPlaybackReport | null>;

const registry = new Map<string, Sample>();

/** Registers `sample` under `key`. Returns the unregister function — call it
 *  on unmount or the moment playback stops. Re-registering the same key (a
 *  fast remount) replaces the entry; the OLDER registration's own unregister
 *  is then a no-op, so it can never evict the newer one that has already
 *  taken its place. */
export function registerPlayback(key: string, sample: Sample): () => void {
  registry.set(key, sample);
  return () => {
    if (registry.get(key) === sample) registry.delete(key);
  };
}

/** Whether any widget is currently registered — checked fresh on every
 *  heartbeat tick, so starting or stopping playback speeds up or slows down
 *  the NEXT tick rather than waiting for the interval to be rebuilt. */
export function anyPlaying(): boolean {
  return registry.size > 0;
}

/** Every registered widget's current report. A sampler's promise rejecting
 *  (a bug in a future caller — `createSampler`'s own sampler never does)
 *  drops just that widget's report rather than the whole heartbeat; a
 *  sampler returning null (nothing to report yet, or `getStats()` failed)
 *  contributes nothing either. */
export async function drainReports(): Promise<VideoPlaybackReport[]> {
  const settled = await Promise.allSettled([...registry.values()].map((sample) => sample()));
  return settled.flatMap((r) => (r.status === "fulfilled" && r.value !== null ? [r.value] : []));
}

/** Test-only: clears every registration, so one test's leaked entry (from a
 *  failure that skipped its own unregister) cannot bleed into the next. */
export function __resetPlaybackRegistryForTests(): void {
  registry.clear();
}
