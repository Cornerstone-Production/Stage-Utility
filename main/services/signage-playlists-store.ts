// signage-playlists-store.ts — ordered collections of media.
//
// A playlist holds mediaIds rather than files, so renaming or replacing a media
// item does not have to touch every playlist that uses it.

import type { SignagePlaylist } from "../types/signage.js";
import { DataStore } from "./data-store.js";

export const signagePlaylistsStore = new DataStore<SignagePlaylist[]>(
  "signage-playlists.json",
  [],
  "config",
);

/**
 * Every playlist, with `items` guaranteed to be a list.
 *
 * THE reader. Five places walked `p.items` — the resolver, the pruner, the
 * media-delete route's usage check and its filter, and the editor in the
 * renderer — and a record without one threw in every one of them. The worst was
 * the resolver: it threw inside the scheduler's catch, and the horizon froze at
 * its last good value for every screen in the building until a restart.
 *
 * The routes refuse such a record now, so this is for the file that already
 * holds one — a hand edit, or a store restored from somewhere. Repairing on read
 * rather than rewriting the file: an operator's data is not this function's to
 * change, and a playlist with no items resolves as unplayable, which is a case
 * every caller already handles.
 *
 * Returns the SAME array when nothing needs repairing, so the common path
 * allocates nothing.
 */
export async function listPlaylists(): Promise<SignagePlaylist[]> {
  const all = await signagePlaylistsStore.load();
  const repaired = all.every((p) => Array.isArray(p.items))
    ? all
    : all.map((p) => (Array.isArray(p.items) ? p : { ...p, items: [] }));

  // Migrated HERE as well as in the resolver, and for a different reason: this
  // is what the editor reads. Without it a screen would be playing a group
  // default while the playlist that provides it showed "Default for: nothing" —
  // the UI contradicting the wall, which is the worst kind of wrong.
  //
  // Imported lazily to keep the groups store out of this module's import graph;
  // a cycle here would be silent.
  const { signageGroupsStore } = await import("./signage-groups-store.js");
  return migrateGroupDefaults(repaired, await signageGroupsStore.load());
}

/**
 * Move a group's `defaultPlaylistId` onto the playlist it names.
 *
 * PURE, and applied on read so an operator's existing default keeps working
 * without anybody having to re-enter it. "The foyer's default playlist" used to
 * be a field on the group; it is now a list of tags on the playlist, which is
 * where the operator is standing when they decide it.
 *
 * Both directions are honoured, and the playlist's own list wins: once someone
 * has edited this on the new screen, a stale field on the old record must not
 * put a tag back that they took off.
 */
export function migrateGroupDefaults(
  playlists: SignagePlaylist[],
  groups: { id: string; defaultPlaylistId?: string | null }[],
): SignagePlaylist[] {
  // Which tags each playlist should pick up, from the old field.
  const inherited = new Map<string, string[]>();
  for (const g of groups) {
    if (!g.defaultPlaylistId) continue;
    inherited.set(g.defaultPlaylistId, [...(inherited.get(g.defaultPlaylistId) ?? []), g.id]);
  }
  if (inherited.size === 0) return playlists;

  return playlists.map((p) => {
    const extra = inherited.get(p.id);
    if (!extra) return p;
    const already = p.defaultForGroupIds ?? [];
    const merged = [...new Set([...already, ...extra])];
    // Same array, same object: a migration that rewrote every playlist on every
    // read would broadcast a new horizon on every tick.
    if (merged.length === already.length) return p;
    return { ...p, defaultForGroupIds: merged };
  });
}
