// main/services/video/seen-store.ts — when each feed was last confirmed live.
//
// Runtime: an observation of what the relay reported, never the operator's
// own work, so it is never restored onto another machine (see stores.ts and
// config-snapshot.test.ts's runtime list).
//
// Kept as a Map in memory so feedState()'s `lastSeenAt` input can be read
// synchronously — video-service.ts builds a whole status snapshot, every
// feed's state included, without awaiting anything. The disk copy exists only
// to survive a restart, and the WRITE to it is throttled to once a minute per
// feed: a feed that stays live for an hour would otherwise mean an atomic
// write plus fsync on every 3 s poll (video-service.ts's STATUS_POLL_MS) for
// the whole hour.

import { DataStore } from "../data-store.js";

/** `{ [feedId]: epoch ms last confirmed live }`. */
export const videoSeenStore = new DataStore<Record<string, number>>("video-seen.json", {}, "runtime");

/** How often any ONE feed's entry may reach disk. The in-memory Map is
 *  updated on every call to noteSeen(); only the write-behind is throttled. */
export const SEEN_WRITE_INTERVAL_MS = 60_000;

const seen = new Map<string, number>();
const lastWrittenAt = new Map<string, number>();

/** Populate the in-memory Map from disk. Call once at startup — see
 *  video-service.ts's init(). Safe to skip in a test that never calls it: an
 *  unloaded Map simply reads every feed as "never seen", which is also the
 *  correct answer for a feed genuinely new to the store. */
export async function loadSeen(): Promise<void> {
  const raw = await videoSeenStore.load();
  for (const [id, at] of Object.entries(raw)) seen.set(id, at);
}

/** Epoch ms `feedId` was last confirmed live, or null if never (or not yet
 *  loaded — see loadSeen). */
export function lastSeenAt(feedId: string): number | null {
  return seen.get(feedId) ?? null;
}

/** Record `feedId` live at `at`: immediate in memory, and on disk at most
 *  once a minute per feed — see the file header. */
export async function noteSeen(feedId: string, at: number): Promise<void> {
  seen.set(feedId, at);
  const last = lastWrittenAt.get(feedId);
  // `undefined` (never written) always writes, regardless of `at`'s own
  // value — a `?? 0` default here would silently suppress a feed's very
  // first write whenever `at` is under SEEN_WRITE_INTERVAL_MS, which is
  // never true of a real Date.now() but is exactly the shape a test drives
  // with relative timestamps.
  if (last !== undefined && at - last < SEEN_WRITE_INTERVAL_MS) return;
  lastWrittenAt.set(feedId, at);
  await videoSeenStore.update((current) => ({ ...current, [feedId]: at }));
}
