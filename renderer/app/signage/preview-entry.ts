// preview-entry.ts — a playlist as the horizon entry a display would receive.
//
// The editor preview and the Now board both draw with SignagePlayer, which takes
// a horizon entry. Building that shape here — rather than giving the player a
// second "preview" input — is what keeps the preview honest: it renders from
// exactly the structure the server pushes to a wall.

import type { SignageHorizonEntry, SignagePlaylist } from "@main/types/signage";
import type { ResolvedItem } from "@main/services/signage-playlist-items";

/**
 * A preview entry for `playlist`.
 *
 * `startedAt` is 0 so the preview's position follows the wall clock modulo the
 * cycle. That means opening the editor does not restart the loop, and two people
 * looking at the same playlist see the same frame.
 */
export function toHorizonPlaylist(
  playlist: SignagePlaylist,
  resolved: ResolvedItem[],
): SignageHorizonEntry {
  return {
    from: 0,
    until: Number.MAX_SAFE_INTEGER,
    reason: "schedule",
    reasonLabel: playlist.name,
    playlist: {
      id: playlist.id,
      startedAt: 0,
      fit: playlist.fit,
      transition: playlist.transition,
      items: resolved.map((r) => ({
        url: `/signage-media/${r.media.file}`,
        mime: r.media.mime,
        durationMs: r.durationMs,
        fit: r.fit,
        transition: r.transition,
        bytes: r.media.bytes,
      })),
    },
  };
}
