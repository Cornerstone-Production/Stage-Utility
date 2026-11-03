// The one coupling between Readiness and Needs attention.
//
// Needs attention lists every failing readiness check, so a Home that holds both
// shows a failing check twice. Readiness stays useful on a fresh install, where
// it is the Getting Started story, so nothing hides it; the editor says why it
// repeats.

import type { LayoutObject } from "@main/types/views";

export const ALSO_SHOWN_NOTE = "Also shown by Needs attention";

/** The note to draw on `card` in the editor, or null. */
export function editorNote(card: LayoutObject, placed: readonly LayoutObject[]): string | null {
  if (card.config.type !== "home-readiness") return null;
  return placed.some((o) => o.config.type === "home-attention") ? ALSO_SHOWN_NOTE : null;
}
