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

export function listPlaylists(): Promise<SignagePlaylist[]> {
  return signagePlaylistsStore.load();
}
