// What the Mic slots page does when `photo-themes:changed` speaks.
//
// The frame carries progress and a position, never the theme book: a finished
// edit, an approval from another browser and a deleted theme all arrive as the
// next `seq`, and the only way to see what happened is to read again. So a live
// frame whose `seq` moved says "read again", and a frame that is not the next
// one, or comes from another server run, says the same and also says a change
// was missed (worth a log line). Skipped: a replayed frame, which is the cached
// last frame from before this page read anything and only tells it where the
// count stands, and a live frame that repeats the `seq` already seen.
//
// Why not useStatusChannel: that hook carries a VALUE whose rev orders a push
// against a read of the same value. This channel carries no value to keep, only
// "the book moved", and what it decides is whether to read the book again. So it
// keeps the server run's `epoch` and the `seq` of the last frame, and a gap in
// `seq` (a frame lost to a reconnect) or a new `epoch` (a restart) is a re-read
// that a rev comparison would have to infer.

import type { PhotoThemesChanged } from "@main/types/photo-themes";

export type FrameReading =
  /** Nothing to read: a replay, or a frame already seen. */
  | { reread: false }
  /** Read again; `why` says whether a frame was lost on the way. */
  | { reread: true; why: "next" | "first" | "missed" | "restart" };

export function readFrame(prev: PhotoThemesChanged | null, next: PhotoThemesChanged, replayed: boolean): FrameReading {
  if (replayed) return { reread: false };
  if (!prev) return { reread: true, why: "first" };
  if (next.epoch !== prev.epoch) return { reread: true, why: "restart" };
  if (next.seq === prev.seq) return { reread: false };
  if (next.seq === prev.seq + 1) return { reread: true, why: "next" };
  return { reread: true, why: "missed" };
}
