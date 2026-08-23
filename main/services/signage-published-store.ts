// signage-published-store.ts — the config the WALLS are running.
//
// Signage has two copies of its configuration now, and the split is the whole
// point: the stores an operator edits, and this one, which is what displays
// resolve from. Nothing an operator types reaches a wall until they push it.
//
// The reason is a service. Building next week's schedule while this week's is on
// the screens used to change the screens as you typed — a graphic swapping
// mid-sentence behind a speaker, because somebody was editing in the office. A
// wall is not a preview surface.
//
// WHAT IS GATED, AND WHAT IS NOT. This holds CONFIG, not time:
//
//   - Schedules already published keep firing on their own. Publishing is not
//     a heartbeat; a Sunday morning window opens whether or not anybody has
//     pressed anything this week.
//   - A TAKE-OVER bypasses this entirely. It is the control you reach for when
//     something is wrong on a wall right now, and making it wait behind a second
//     button would be indefensible.
//   - The media library is not here either. Files are content-addressed and
//     additive: uploading one changes nothing until a playlist points at it, and
//     that playlist edit is gated like any other.

import type { SignageGroup, SignagePlaylist, SignageSchedule } from "../types/signage.js";
import { DataStore } from "./data-store.js";

export interface PublishedSignage {
  /** Epoch ms of the push, or null when nothing has ever been pushed. */
  publishedAt: number | null;
  playlists: SignagePlaylist[];
  groups: SignageGroup[];
  schedules: SignageSchedule[];
}

export const EMPTY_PUBLISHED: PublishedSignage = {
  publishedAt: null,
  playlists: [],
  groups: [],
  schedules: [],
};

/**
 * Config, so a backup carries it.
 *
 * It has to: restoring a snapshot and finding every wall blank until somebody
 * noticed there was a second button to press would be a bad hour.
 */
export const signagePublishedStore = new DataStore<PublishedSignage>(
  "signage-published.json",
  EMPTY_PUBLISHED,
  "config",
);

/** What each store holds, for comparing and for copying. */
export interface SignageConfigTriple {
  playlists: SignagePlaylist[];
  groups: SignageGroup[];
  schedules: SignageSchedule[];
}

/**
 * What is waiting to be pushed, in words an operator can act on.
 *
 * Counted per KIND rather than as one number, because "3 changes" tells you
 * nothing about whether you are about to change what is on a wall. Ordering
 * matters too — a schedule reorder IS a change, since order is the priority
 * rule — so this compares the lists as sequences, not as sets.
 */
export function pendingChanges(
  live: SignageConfigTriple,
  published: PublishedSignage,
): { playlists: number; groups: number; schedules: number; total: number } {
  const playlists = countDifferences(live.playlists, published.playlists);
  const groups = countDifferences(live.groups, published.groups);
  const schedules = countDifferences(live.schedules, published.schedules);
  return { playlists, groups, schedules, total: playlists + groups + schedules };
}

/**
 * How many records differ, added or removed included.
 *
 * A reorder counts as changed even when every record is identical, because for
 * schedules the order IS the configuration. Compared by JSON: the shapes are
 * small, and a hand-written comparison is how a field comes to be silently
 * ignored by the thing that decides whether to show a Push button.
 */
function countDifferences<T extends { id: string }>(live: T[], published: T[]): number {
  const before = new Map(published.map((r) => [r.id, JSON.stringify(r)]));
  const after = new Map(live.map((r) => [r.id, JSON.stringify(r)]));

  let changed = 0;
  for (const [id, json] of after) if (before.get(id) !== json) changed++;
  for (const id of before.keys()) if (!after.has(id)) changed++;

  // Only counted when nothing else already accounts for it, so moving one row
  // reads as "1 schedule" rather than as every row below it having moved.
  if (changed === 0) {
    const liveOrder = live.map((r) => r.id).join("\u0000");
    const publishedOrder = published.map((r) => r.id).join("\u0000");
    if (liveOrder !== publishedOrder) changed = 1;
  }
  return changed;
}

/**
 * Read the published config, adopting the live one the FIRST time.
 *
 * The upgrade path, and it has to WRITE rather than merely fall back. Before
 * this existed every wall ran the live stores, so an install meeting an empty
 * snapshot must not go black — but simply answering "live" while nothing is
 * published makes the two identical forever, so nothing ever reads as pending
 * and the Push button can never appear. That is the shape this had first, and
 * it silently disabled the entire feature.
 *
 * So the first read adopts what is already running, exactly as it is. Nothing
 * changes on a wall, and every edit after that is a real pending change.
 */
export async function publishedOrLive(live: SignageConfigTriple): Promise<PublishedSignage> {
  const published = await signagePublishedStore.load();
  if (published.publishedAt !== null) return published;
  console.log("[signage] adopting the current configuration as published");
  return publishSignage(live);
}

/**
 * Put the live config on the walls.
 *
 * Returns what was published, so the caller can say what it did rather than
 * assume it worked.
 */
export async function publishSignage(live: SignageConfigTriple): Promise<PublishedSignage> {
  const next: PublishedSignage = {
    publishedAt: Date.now(),
    // Copied, not referenced: this is a snapshot, and a later edit to the live
    // store must not reach back into what the walls are running.
    playlists: structuredClone(live.playlists),
    groups: structuredClone(live.groups),
    schedules: structuredClone(live.schedules),
  };
  await signagePublishedStore.save(next);
  return next;
}
