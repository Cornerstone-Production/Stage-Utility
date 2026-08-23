// preview-entry.ts — a playlist as the horizon entry a display would receive.
//
// The editor preview and the Now board both draw with SignagePlayer, which takes
// a horizon entry. Building that shape here — rather than giving the player a
// second "preview" input — is what keeps the preview honest: it renders from
// exactly the structure the server pushes to a wall.

import type { SignageHorizonEntry, SignagePlaylist } from "@main/types/signage";
import type { ResolvedItem } from "@main/services/signage-playlist-items";
import { toHorizonItems } from "@main/services/signage-playlist-items";

/**
 * A preview entry for `playlist`.
 *
 * `startedAt` is the moment this playlist came up in the editor, NOT zero.
 *
 * Anchored at zero, the preview's position is `Date.now() % cycleMs` — and that
 * has no relation to the same clock modulo a different cycle length. Every press
 * of the duration stepper changed the cycle and threw the preview onto an
 * unrelated item; holding the stepper flipped through the whole playlist. See
 * usePreviewEpoch, which is where the anchor comes from.
 *
 * A real screen keeps the server's startedAt, which is what holds two walls in
 * step. Nothing in an editor preview needs that.
 */
export function toHorizonPlaylist(
  playlist: SignagePlaylist,
  resolved: ResolvedItem[],
  startedAt: number,
): SignageHorizonEntry {
  return {
    from: 0,
    until: Number.MAX_SAFE_INTEGER,
    reason: "schedule",
    reasonLabel: playlist.name,
    playlist: {
      id: playlist.id,
      startedAt,
      fit: playlist.fit,
      transition: playlist.transition,
      items: toHorizonItems(resolved),
    },
  };
}
