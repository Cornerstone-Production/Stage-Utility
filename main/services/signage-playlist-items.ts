// signage-playlist-items.ts — a playlist's items, resolved to what actually plays.
//
// PURE, and shared. The resolver builds a horizon entry from this, and the
// playlist editor shows the operator the cycle length it produces. Two
// implementations of the same rule would drift, and the symptom would be an
// editor that quietly disagrees with the wall.
//
// The rule worth stating out loud: a VIDEO uses its own length and ignores both
// the per-item duration and the playlist default. Cutting a 42-second clip off
// after 8 seconds because that is the playlist's default reads as a broken
// video, not as a misconfigured playlist.

import type {
  SignageFit,
  SignageHorizonItem,
  SignageMedia,
  SignagePlaylist,
  SignageTransition,
} from "../types/signage.js";
import { isSignageVideo } from "../types/signage.js";

/** One item, with everything the player needs and nothing left to look up. */
export interface ResolvedItem {
  mediaId: string;
  media: SignageMedia;
  durationMs: number;
  fit: SignageFit;
  transition: SignageTransition;
}

/** Last-resort length for an image whose playlist has no usable default. A
 *  zero-length item takes no time, so a playlist of them has a zero-length cycle
 *  and nothing can play at all. */
const FALLBACK_IMAGE_MS = 8000;

/**
 * The items of `playlist` that can actually play, in order.
 *
 * Items are DROPPED rather than substituted when they cannot play — media that
 * no longer exists, or a video with no recorded duration. A dropped item is
 * visible to the caller (the list is shorter than the playlist) so it can be
 * reported; an invented one would sit on a wall for an invented length of time
 * with nothing to notice.
 */
export function resolveItemDurations(
  playlist: SignagePlaylist,
  media: SignageMedia[],
): ResolvedItem[] {
  const byId = new Map(media.map((m) => [m.id, m]));
  const out: ResolvedItem[] = [];

  // A playlist whose `items` is missing or not a list has nothing that can play,
  // which is a case every caller already handles — an unplayable playlist falls
  // through to the next precedence step. Iterating it instead threw inside the
  // scheduler's catch and FROZE the horizon for every screen until a restart.
  if (!Array.isArray(playlist.items)) return out;

  for (const item of playlist.items) {
    const m = byId.get(item.mediaId);
    if (!m) continue; // the file was deleted out from under this playlist

    let durationMs: number;
    if (isSignageVideo(m.mime)) {
      // The clip's own length, full stop.
      if (!m.durationMs || m.durationMs <= 0) continue; // hand-edited store; do not guess
      durationMs = m.durationMs;
    } else {
      const chosen = item.durationMs ?? playlist.defaultDurationMs;
      durationMs = chosen > 0 ? chosen : FALLBACK_IMAGE_MS;
    }

    out.push({
      mediaId: item.mediaId,
      media: m,
      durationMs,
      fit: item.fit ?? playlist.fit,
      transition: item.transition ?? playlist.transition,
    });
  }

  return out;
}

/**
 * Resolved items as the shape that travels in a horizon entry.
 *
 * Shared with the renderer, which builds a preview entry for the playlist editor
 * and the Now board. It was written out twice, identically, and the failure mode
 * is quiet: add a field to a horizon item and the preview keeps omitting it, so
 * the editor disagrees with the wall about something nobody thought to check.
 */
export function toHorizonItems(items: ResolvedItem[]): SignageHorizonItem[] {
  return items.map((r) => ({
    url: `/signage-media/${r.media.file}`,
    mime: r.media.mime,
    durationMs: r.durationMs,
    fit: r.fit,
    transition: r.transition,
    bytes: r.media.bytes,
  }));
}

/** How long one revolution of `items` takes. Mirrors the renderer's cycleMs, on
 *  resolved items rather than raw ones. */
export function resolvedCycleMs(items: ResolvedItem[]): number {
  let total = 0;
  for (const i of items) total += Math.max(0, i.durationMs);
  return total;
}
