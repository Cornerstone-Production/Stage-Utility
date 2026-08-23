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
  if (all.every((p) => Array.isArray(p.items))) return all;
  return all.map((p) => (Array.isArray(p.items) ? p : { ...p, items: [] }));
}
