// Where a drag ended, and whether that counts as "on the bar".
//
// Its own module because getting this wrong is invisible: the configurator
// still renders, still animates, still reorders — it just silently refuses to
// remove anything. Two plausible implementations were both wrong before this
// one, and neither could be tested where it lived.
//
//   `over` — closestCenter returns the NEAREST droppable however far the
//   pointer is from it, so `over` is never null and "released over nothing"
//   never happens.
//
//   the dragged node's rect — with a DragOverlay the source node stays exactly
//   where it was, so its rect says "still in the bar" for the whole drag.
//
// The activator event plus the drag delta is the pointer, and it is the only
// one of the three that moves.

/** Just enough of dnd-kit's DragEndEvent to decide. */
export interface DragEndGeometry {
  activatorEvent: Event;
  delta: { x: number; y: number };
}

/** Just enough of a DOMRect. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The pointer position the drag started from, mouse or touch. */
function activatorPoint(ev: Event): { x: number; y: number } | null {
  const e = ev as MouseEvent & TouchEvent;
  const touch = e.touches?.[0] ?? e.changedTouches?.[0];
  if (touch) return { x: touch.clientX, y: touch.clientY };
  return typeof e.clientX === "number" ? { x: e.clientX, y: e.clientY } : null;
}

/** Where the pointer was when the drag ended. */
export function dropPoint(e: DragEndGeometry): { x: number; y: number } | null {
  const from = activatorPoint(e.activatorEvent);
  return from ? { x: from.x + e.delta.x, y: from.y + e.delta.y } : null;
}

/**
 * Did the drag finish over the bar?
 *
 * `pad` is for the bar's own thinness — 44px is an easy thing to wobble out of
 * while aiming at it, and every pixel outside it deletes an item.
 *
 * Answers TRUE when there is no pointer to judge by: with nothing to go on,
 * keeping the item is recoverable and deleting it on a guess is not.
 */
export function droppedOnBar(e: DragEndGeometry, bar: Box | null, pad = 16): boolean {
  const p = dropPoint(e);
  if (!bar || !p) return true;
  return p.x >= bar.left - pad && p.x <= bar.right + pad
    && p.y >= bar.top - pad && p.y <= bar.bottom + pad;
}

/**
 * Which gap a drag would land in: a caret drawn before `keys[gap]`.
 *
 * A reorder is not the same as an insert, and one rule for both lies half the
 * time. Dropping onto a row from the palette puts the new item BEFORE it.
 * Dragging a row rightwards past another lands AFTER it, because the dragged
 * row leaves its own slot first — the same off-by-one `arrayMove` already has,
 * stated once here so the caret and the drop cannot disagree.
 *
 * `null` means nothing would be inserted.
 */
export function insertionGap(
  keys: readonly string[],
  activeId: string,
  overId: string | null,
): number | null {
  if (overId === null) return null;
  // The strip itself rather than a row in it: past the end.
  if (overId === "bar") return keys.length;
  const to = keys.indexOf(overId);
  if (to === -1) return null;
  const from = keys.indexOf(activeId);
  // Not in the bar yet, so it comes from the palette.
  if (from === -1) return to;
  return from < to ? to + 1 : to;
}
