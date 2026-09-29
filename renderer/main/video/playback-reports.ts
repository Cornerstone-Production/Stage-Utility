// renderer/main/video/playback-reports.ts — the per-widget registry the
// screen's presence heartbeat drains.
//
// A Video widget instance calls registerPlayback once it is actually showing
// a relay or external feed's picture (never an embed, whose playback Stage
// Utility cannot measure at all), and calls the returned unregister function
// the moment it stops — on unmount, or when the picture it was showing goes
// away. Keyed by WIDGET INSTANCE (video-object.tsx's useId()), not by feed
// or layout object: two widgets playing the same feed, or an embed tile and
// its expanded copy drawing one object twice, are two keys, two samples, two
// reports.

import type { VideoPlaybackReport } from "@main/types/video";

/** How often the presence heartbeat fires while at least one widget is
 *  registered here — faster than either of its normal near/far cadences
 *  (stage-view.tsx), since a stalled or dropped picture is worth knowing
 *  about sooner than a screen merely being present. */
export const VIDEO_HEARTBEAT_MS = 10_000;

type Sample = () => Promise<VideoPlaybackReport | null>;

const registry = new Map<string, Sample>();

/** Notified whenever `anyPlaying()` FLIPS — nothing playing to something, or
 *  back — never on every register/unregister, so a widget cycling through
 *  several attempts while at least one other stays registered notifies
 *  nobody. stage-view.tsx's presence heartbeat uses this to reschedule the
 *  moment playback starts or stops, the same way it already reschedules the
 *  moment PCO goes live, rather than riding out whatever cadence its
 *  currently pending timer already committed to. */
const listeners = new Set<() => void>();

function notifyIfFlipped(wasPlaying: boolean): void {
  if (wasPlaying !== anyPlaying()) for (const cb of listeners) cb();
}

/** Registers `sample` under `key`. Returns the unregister function — call it
 *  on unmount or the moment playback stops. Re-registering the same key (the
 *  same instance's effect running again with a new sampler) replaces the
 *  entry; the OLDER registration's own unregister is then a no-op, so it can
 *  never evict the newer one that has already taken its place. */
export function registerPlayback(key: string, sample: Sample): () => void {
  const wasPlaying = anyPlaying();
  registry.set(key, sample);
  notifyIfFlipped(wasPlaying);
  return () => {
    if (registry.get(key) !== sample) return;
    const was = anyPlaying();
    registry.delete(key);
    notifyIfFlipped(was);
  };
}

/** Whether any widget is currently registered. */
export function anyPlaying(): boolean {
  return registry.size > 0;
}

/** Subscribes to `anyPlaying()` flipping. Returns the unsubscribe function. */
export function onAnyPlayingChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
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

/** How long the presence heartbeat waits on drainReports() before sending
 *  without video: the heartbeat is what keeps the screen's Connected dot on,
 *  and a sampler that never answers must not hold it. */
export const DRAIN_TIMEOUT_MS = 2_000;

/** drainReports(), or no reports at all if it has not settled within
 *  DRAIN_TIMEOUT_MS. A late result is dropped, never carried into the next
 *  heartbeat: each report is a delta since its sampler's last read, so the
 *  next drain already counts what this one missed. */
export async function drainReportsInTime(): Promise<VideoPlaybackReport[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<VideoPlaybackReport[]>((resolve) => {
    timer = setTimeout(() => resolve([]), DRAIN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([drainReports(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only: clears every registration and subscriber, so one test's leaked
 *  entry (from a failure that skipped its own unregister/unsubscribe) cannot
 *  bleed into the next. */
export function __resetPlaybackRegistryForTests(): void {
  registry.clear();
  listeners.clear();
}
