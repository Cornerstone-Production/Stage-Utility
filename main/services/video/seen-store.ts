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

/**
 * Record `feedId` live at `at`: immediate in memory, and on disk at most once
 * a minute per feed — see the file header.
 *
 * `lastWrittenAt` is set only AFTER the write actually lands. Setting it
 * first (as an earlier version of this function did) marks a feed "written"
 * even when the disk write REJECTS, which then throttles away every retry
 * for the rest of the window — a failure would have silenced itself instead
 * of being retried on the next poll. The write can still throw; the caller
 * decides what to do with that (see video-service.ts's recordSeen()).
 */
export async function noteSeen(feedId: string, at: number): Promise<void> {
  seen.set(feedId, at);
  const last = lastWrittenAt.get(feedId);
  // `undefined` (never written) always writes, regardless of `at`'s own
  // value — a `?? 0` default here would silently suppress a feed's very
  // first write whenever `at` is under SEEN_WRITE_INTERVAL_MS, which is
  // never true of a real Date.now() but is exactly the shape a test drives
  // with relative timestamps.
  if (last !== undefined && at - last < SEEN_WRITE_INTERVAL_MS) return;
  await videoSeenStore.update((current) => ({ ...current, [feedId]: at }));
  lastWrittenAt.set(feedId, at);
}

/**
 * Force the CURRENT in-memory value to disk now, ignoring the throttle.
 *
 * Called on a feed's transition OUT of a ready state: `noteSeen()`'s own
 * writes are throttled to once a minute, so a feed that was live for, say,
 * 57 seconds before dropping has its true last-seen moment sitting only in
 * memory — the on-disk copy can lag it by up to SEEN_WRITE_INTERVAL_MS. This
 * closes that gap at exactly the moment it would otherwise show, without
 * uncapping the throttle for a feed that stays live for hours.
 */
export async function flushSeen(feedId: string): Promise<void> {
  const at = seen.get(feedId);
  if (at === undefined) return; // nothing has ever been recorded for this feed
  await videoSeenStore.update((current) => ({ ...current, [feedId]: at }));
  lastWrittenAt.set(feedId, at);
}

/**
 * Forget everything about `feedId` — memory and disk.
 *
 * Called from video-service.ts's removeFeed(): a NEW feed can mint this same
 * id again (feedIdFor() is deterministic from the name), and it has no
 * history of its own. Without this, re-adding a push feed under the same
 * name would read "offline, last seen <old>" instead of "waiting".
 */
export async function forgetSeen(feedId: string): Promise<void> {
  seen.delete(feedId);
  lastWrittenAt.delete(feedId);
  await videoSeenStore.update((current) => {
    if (!(feedId in current)) return current; // nothing to remove — no write
    const { [feedId]: _removed, ...rest } = current;
    return rest;
  });
}
