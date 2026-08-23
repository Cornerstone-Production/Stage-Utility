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
  /** For a trimmed video this is the TRIMMED length, not the file's. */
  durationMs: number;
  fit: SignageFit;
  transition: SignageTransition;
  /** Video only, and only when trimmed. */
  trimStartMs?: number;
  trimEndMs?: number;
}

/**
 * Where a video actually starts and stops, and how long that is.
 *
 * PURE and exported so the editor can show the trimmed length while the
 * operator drags the numbers, rather than after a save.
 *
 * Every way an operator can enter nonsense resolves to something playable
 * rather than to a refusal: out beyond the end clamps to the end, in past out
 * yields nothing and the caller drops the item. A wall is not the place to
 * discover that a number was typed wrong, but neither is a validation error the
 * thing to put there.
 */
export function trimOf(
  item: { trimStartMs?: number; trimEndMs?: number },
  clipMs: number,
): { startMs: number; endMs: number; durationMs: number } {
  // Each end falls back to ITS OWN sensible default, not to a shared one. A
  // clamp that answered 0 for anything non-finite turned an Infinity out-point
  // into a zero-length trim and dropped the clip — an untrimmed video vanishing
  // because a number was wrong, rather than simply playing whole.
  const start = clamp(item.trimStartMs, 0, clipMs, 0);
  const end = clamp(item.trimEndMs, 0, clipMs, clipMs);
  return { startMs: start, endMs: end, durationMs: Math.max(0, end - start) };
}

function clamp(v: number | undefined, lo: number, hi: number, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
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
  /**
   * The library, or an index of it.
   *
   * An INDEX where the caller resolves more than one playlist. The resolver
   * calls this once per output per horizon edge — up to a couple of hundred
   * times per recompute — and rebuilding a Map over the whole library each time
   * is, with a 400-file library and 40 edges, on the order of a million map
   * inserts per recompute, on a Pi, every time anything is saved.
   */
  media: SignageMedia[] | ReadonlyMap<string, SignageMedia>,
): ResolvedItem[] {
  const byId: ReadonlyMap<string, SignageMedia> = Array.isArray(media)
    ? new Map(media.map((m) => [m.id, m]))
    : media;
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
    let trim: { startMs: number; endMs: number } | null = null;
    if (isSignageVideo(m.mime)) {
      // The clip's own length, or the trimmed part of it. Never the playlist
      // default — cutting a 42-second clip off after eight seconds because that
      // is the default reads as a broken video, not a misconfigured playlist.
      if (!m.durationMs || m.durationMs <= 0) continue; // hand-edited store; do not guess
      const t = trimOf(item, m.durationMs);
      // A trim that leaves nothing is dropped like any other unplayable item,
      // rather than becoming a zero-length turn that the cycle skips past
      // invisibly.
      if (t.durationMs <= 0) continue;
      durationMs = t.durationMs;
      // Only carried when it is actually a trim, so an untrimmed clip's URL
      // stays exactly what it was.
      if (t.startMs > 0 || t.endMs < m.durationMs) trim = { startMs: t.startMs, endMs: t.endMs };
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
      ...(trim ? { trimStartMs: trim.startMs, trimEndMs: trim.endMs } : {}),
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
    ...(r.trimStartMs === undefined ? {} : { trimStartMs: r.trimStartMs }),
    ...(r.trimEndMs === undefined ? {} : { trimEndMs: r.trimEndMs }),
  }));
}

