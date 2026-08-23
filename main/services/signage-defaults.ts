// signage-defaults.ts — which playlist a tag falls back to, and who claims it.
//
// PURE, and the ONE statement of the rule. It moved from `group.defaultPlaylistId`
// to `playlist.defaultForGroupIds` when groups became tags; the resolver moved,
// two other readers did not, and both were silently broken for every tag made
// after that change:
//
//   - the delete blocker still asked the GROUP for its default, so a playlist
//     that was a tag's only content could be deleted with no refusal — the exact
//     failure signage-integrity's own comment says it exists to prevent
//   - /offline-assets asked the same way, so it answered "this group has no
//     default playlist" for every tag that had one, on the screen whose whole
//     job is confirming a Pi can boot with the server off
//
// Neither was a typo. Both were a second copy of a rule that moved. So the rule
// lives here now and the resolver, the blocker and the route all call it.

import type { SignageGroup, SignagePlaylist } from "../types/signage.js";

/**
 * The playlist a screen in these tags falls back to, and the tag it won on.
 *
 * Walks PLAYLISTS in list order, not groups, and that ordering is the entire
 * tie-break: several playlists may declare themselves the default for one tag —
 * a weekend loop and a youth loop on the same foyer screens is a real thing an
 * operator wants — and the first of them wins. Order is something they can see
 * and change; anything else would be a rule they have to be told.
 *
 * @param isPlayable optional. The resolver passes one so an unplayable default
 *   falls through to the next claimant rather than blanking the screen, exactly
 *   as an unplayable schedule does. Callers that only need "which playlist is
 *   named" omit it.
 */
export function tagDefault<T extends SignagePlaylist>(
  playlists: readonly T[],
  tagIds: ReadonlySet<string>,
  isPlayable?: (playlist: T) => boolean,
): { playlist: T; tagId: string } | null {
  if (tagIds.size === 0) return null;
  for (const candidate of playlists) {
    const tagId = (candidate.defaultForGroupIds ?? []).find((id) => tagIds.has(id));
    if (tagId === undefined) continue;
    if (isPlayable && !isPlayable(candidate)) continue;
    return { playlist: candidate, tagId };
  }
  return null;
}

/**
 * The tags that would lose their fallback content if this playlist went.
 *
 * Every tag it CLAIMS, not only the ones it currently wins: a claim it loses
 * today it wins the moment the playlist above it is deleted or emptied, and an
 * operator deleting a playlist wants to be told about both.
 *
 * Reads the legacy `group.defaultPlaylistId` as well, because this runs on the
 * raw store rather than the migrating reader. An un-migrated file must still
 * refuse the delete.
 */
export function tagsDefaultingTo(
  playlistId: string,
  playlists: readonly SignagePlaylist[],
  groups: readonly SignageGroup[],
): string[] {
  if (!playlistId) return [];
  const claimed = new Set(
    playlists.find((p) => p.id === playlistId)?.defaultForGroupIds ?? [],
  );
  return groups
    .filter((g) => claimed.has(g.id) || g.defaultPlaylistId === playlistId)
    .map((g) => g.name);
}
