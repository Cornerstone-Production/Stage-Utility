// What the sidebar's and the context bar's editors share when something is
// dragged: the sensors, the class on everything draggable, and the caret.
//
// One copy, because the two editors are one Customize mode and must feel like
// one: a drag that starts on a held finger in one and on a touch in the other,
// or a caret drawn two ways, is two tools pretending to be one.

import { MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";

import { cn } from "../lib/cn";

/**
 * Mouse and touch separately, never a lone PointerSensor, which claims a touch
 * gesture on touch-down and stops the page scrolling on a phone. A touch drag
 * starts only after a still 200 ms hold, so a swipe scrolls and a long-press
 * then move drags.
 */
export function usePointerSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
}

/**
 * On everything that can be dragged.
 *
 * Nothing draggable may be selectable: a drag that crosses text starts a native
 * selection, and the browser gives the mouseup to THAT rather than to the drag,
 * so the ghost stayed stuck to the pointer with no way to put it down. The
 * callout is iOS's long-press menu, which would open on the same hold that
 * starts a drag. `touch-manipulation`, never `touch-none`: a finger has to be
 * able to scroll the list or strip the thing sits in.
 */
export const DRAGGABLE = "cursor-grab active:cursor-grabbing touch-manipulation select-none [-webkit-touch-callout:none]";

/**
 * Where the dragged thing will land: a line across a column of rows (the
 * sidebar), or a bar between two readings (the context bar).
 */
export function Caret({ along, at }: { along: "column" | "row"; at?: number }) {
  if (along === "row") {
    return <span aria-hidden="true" className="-mx-1 h-6 w-0.5 shrink-0 self-center rounded-full bg-accent" />;
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-3.5 right-3.5 z-[5] h-0.5 rounded-sm bg-accent",
        "before:absolute before:-left-1 before:-top-[3px] before:size-2 before:rounded-full before:border-2 before:border-accent before:bg-rail",
      )}
      style={{ top: at }}
    />
  );
}
