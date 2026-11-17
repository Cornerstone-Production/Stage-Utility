// The pointer and boxes a drag is judged by, shared by the sidebar's and the
// context bar's editors.
//
// The pointer is the activator event plus the drag delta: with a DragOverlay the
// dragged node never moves, so its rect says nothing about where the drag is.

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
export function activatorPoint(ev: Event): { x: number; y: number } | null {
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

/** Is the point inside the box, grown by `pad` on every side? False with no box. */
export function pointInBox(box: Box | null, p: { x: number; y: number }, pad = 0): boolean {
  return !!box && p.x >= box.left - pad && p.x <= box.right + pad && p.y >= box.top - pad && p.y <= box.bottom + pad;
}
