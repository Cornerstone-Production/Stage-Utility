// One draggable row.
//
// The same six lines had been written out five times — Screens' output cards,
// two rows in Slots, the context-bar item chooser, and Home's card editor. Every
// copy computed the identical transform/transition/opacity style, and two of them
// also repeated the `role`/`tabIndex` strip below, one of them without the
// comment explaining why it exists.
//
// So this is the shape, once. It does not wrap dnd-kit or hide it: the caller
// still owns its DndContext, its sensors and its collision strategy, because
// those genuinely differ (a grid uses rectSortingStrategy, a column does not).

import type { CSSProperties } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface SortableRow {
  setNodeRef: (node: HTMLElement | null) => void;
  /** Transform, transition and the drag-ghost opacity. Spread onto the row. */
  style: CSSProperties;
  /** dnd-kit's attributes, untouched. Correct on a row that IS a button. */
  attributes: DraggableAttributes;
  /**
   * The same, MINUS role and tabIndex.
   *
   * dnd-kit sets `role="button"`, which announces a button wrapping whatever the
   * row contains — a textbox, in three of the five callers. The drag-description
   * attributes that make a keyboard drag intelligible are kept.
   *
   * Both are offered rather than one being chosen here: which is right depends
   * on what the caller spreads them onto, and quietly changing that for four
   * existing surfaces is not what extracting a shape should do.
   */
  dragA11y: Omit<DraggableAttributes, "role" | "tabIndex">;
  /** The pointer handlers. Put them on the row, or on a grip inside it. */
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

export function useSortableRow(
  id: string,
  opts?: { disabled?: boolean },
): SortableRow {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: opts?.disabled,
  });
  const { role: _role, tabIndex: _tabIndex, ...dragA11y } = attributes;
  return {
    attributes,
    setNodeRef,
    style: {
      transform: CSS.Transform.toString(transform),
      transition,
      opacity: isDragging ? 0.5 : 1,
    },
    dragA11y,
    listeners,
    isDragging,
  };
}
