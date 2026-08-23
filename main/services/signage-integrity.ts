// signage-integrity.ts — what would break if this were deleted.
//
// PURE. The repo's existing rule, applied to signage: a delete that would break
// something is refused and NAMES what it would break. Naming matters as much as
// refusing — "in use by 1 schedule" leaves the operator hunting, and what they
// are hunting for is why a wall went blank.
//
// Media is the exception and does not refuse: a file removed from the library
// should go, and the playlists that referenced it are reported back so the
// caller can say which ones changed rather than the operator discovering it.

import type { SignageGroup, SignagePlaylist, SignageSchedule } from "../types/signage.js";

/** Everything that would break if this playlist went. */
export function playlistUsage(
  playlistId: string,
  schedules: SignageSchedule[],
  groups: SignageGroup[],
): { schedules: string[]; groups: string[] } {
  // An empty id would otherwise match every group whose default is unset, making
  // every playlist permanently undeletable.
  if (!playlistId) return { schedules: [], groups: [] };
  return {
    schedules: schedules.filter((s) => s.playlistId === playlistId).map((s) => s.name),
    // A playlist used ONLY as a group default is still in use, and nothing in
    // the schedule list points at it. Missing this is how deleting a playlist
    // silently blanks a group - including a Pi that boots with no server, whose
    // whole content is that default.
    groups: groups.filter((g) => g.defaultPlaylistId === playlistId).map((g) => g.name),
  };
}

/** The schedules that target this group. */
export function groupUsage(groupId: string, schedules: SignageSchedule[]): string[] {
  if (!groupId) return [];
  return schedules.filter((s) => s.groupIds.includes(groupId)).map((s) => s.name);
}

/** The playlists holding this media item, each named once. */
export function mediaUsage(mediaId: string, playlists: SignagePlaylist[]): string[] {
  if (!mediaId) return [];
  // The same graphic twice in one playlist is legitimate - a bumper at the start
  // and the end - and listing it twice would read as two playlists.
  return playlists.filter((p) => p.items.some((i) => i.mediaId === mediaId)).map((p) => p.name);
}

/** "Weekend mornings and Office hours", for a refusal an operator can act on. */
export function andList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
