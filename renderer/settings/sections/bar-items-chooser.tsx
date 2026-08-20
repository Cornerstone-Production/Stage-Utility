// Which context-bar items appear, and in what order.
//
// Reorderable with the SAME MouseSensor/TouchSensor pair the rest of the app
// uses — never a single PointerSensor, which claimed the gesture on touch-down
// and made lists unscrollable on a phone.

import { DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { ArrowRightToLineIcon, GripVerticalIcon } from "lucide-react";
import { BAR_ITEMS, BAR_SPLIT, visibleBarItems, type BarItemId, type BarRowId } from "../../app/bar-items";
import { Checkbox } from "../../components/ui/checkbox";
import { cn } from "../../lib/cn";
import { useSortableRow } from "../../lib/use-sortable-row";

const ALL_IDS = Object.keys(BAR_ITEMS) as BarItemId[];

/** The alignment split, as a row you drag.
 *
 *  It has no checkbox because it cannot be turned off: the bar always has a
 *  left group and a right group, and this only says where one ends. Dragged to
 *  the top, everything is right-aligned; to the bottom, everything is left. */
function SplitRow() {
  const { setNodeRef, style, attributes, listeners } = useSortableRow(BAR_SPLIT);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong bg-fill px-3 py-2.5"
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="shrink-0 cursor-grab touch-pan-y text-fg-faint transition-colors hover:text-fg-muted active:cursor-grabbing"
        aria-label="Reorder the alignment split"
        tabIndex={-1}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <ArrowRightToLineIcon className="size-4 shrink-0 text-fg-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block text-footnote font-medium text-fg">Right-aligned from here</span>
        <span className="block text-caption2 text-fg-subtle">
          Everything below this sits at the right of the bar.
        </span>
      </span>
    </div>
  );
}

function Row({ id, checked, onToggle }: { id: BarItemId; checked: boolean; onToggle: () => void }) {
  const { setNodeRef, style, attributes, listeners } = useSortableRow(id);
  const item = BAR_ITEMS[id];
  const Icon = item.icon;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5"
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="shrink-0 cursor-grab touch-pan-y text-fg-faint transition-colors hover:text-fg-muted active:cursor-grabbing"
        aria-label={`Reorder ${item.label}`}
        tabIndex={-1}
      >
        <GripVerticalIcon className="size-4" />
      </button>
      <Icon className={cn("size-4 shrink-0", checked ? "text-accent" : "text-fg-faint")} />
      <span className="min-w-0 flex-1">
        <span className="block text-footnote font-medium text-fg">{item.label}</span>
        <span className="block text-caption2 text-fg-subtle">{item.hint}</span>
      </span>
      <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={`Show ${item.label}`} />
    </div>
  );
}

export function BarItemsChooser({
  selected,
  onChange,
}: {
  /** Saved order. Empty means "never configured" — the default is shown. */
  selected: readonly string[];
  onChange: (items: string[]) => void;
}) {
  // THE SAME function the bar renders from, so the list cannot describe a bar
  // different from the one above it. It supplies the default for an
  // unconfigured bar — otherwise the operator sees an empty list above a bar
  // that plainly has items in it — and guarantees exactly one split row.
  const chosen: BarRowId[] = visibleBarItems(selected);

  // Chosen first in their order, then everything else, so dragging orders the
  // visible ones and the rest sit below waiting to be turned on.
  const rest = ALL_IDS.filter((id) => !chosen.includes(id));
  const rows: BarRowId[] = [...chosen, ...rest];

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  function toggle(id: BarItemId) {
    onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = rows.indexOf(active.id as BarRowId);
    const to = rows.indexOf(over.id as BarRowId);
    if (from === -1 || to === -1) return;
    // Reordering only means anything for items that are ON; the order saved is
    // the chosen ones in their new relative order. The split is always chosen,
    // so it survives a drag past the switched-off rows below it.
    const next = arrayMove(rows, from, to).filter((id) => chosen.includes(id));
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <p className="text-caption1 text-fg-subtle">
        Shown above every page, in this order. This is shared — everyone sees the same bar.
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={rows} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {rows.map((id) =>
              id === BAR_SPLIT ? (
                <SplitRow key={id} />
              ) : (
                <Row key={id} id={id} checked={chosen.includes(id)} onToggle={() => toggle(id)} />
              ),
            )}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
