// Home's editor, in Home's tab.
//
// Phase 6 sent this to the canvas editor at /screens/home/edit. Nobody places
// pixels on a home dashboard — it is a stack of cards you either want or you do
// not — so this is the whole editor: a switch and a drag handle per card.
//
// It replaces the page in place rather than opening beside it. A split view
// would halve the cards it is editing, and the list is short enough to hold in
// your head; Done puts the real page back.

import { DndContext, closestCenter, type DragEndEvent, type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { GripVerticalIcon } from "lucide-react";

import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/cn";
import type { HomeCardRow, HomeCardType } from "./home-cards";
import { useSortableRow } from "../../lib/use-sortable-row";

function CardRow({
  row,
  onToggle,
}: {
  row: HomeCardRow;
  onToggle: () => void;
}) {
  // A card that is switched off has no position on the page, so there is nothing
  // to reorder it against.
  const { setNodeRef, style, dragA11y, listeners } = useSortableRow(row.type, {
    disabled: !row.present,
  });

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...dragA11y}
      className={cn(
        "flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5",
        !row.present && "opacity-60",
      )}
    >
      <button
        type="button"
        {...listeners}
        disabled={!row.present}
        aria-label={`Reorder ${row.label}`}
        className={cn(
          "shrink-0 text-fg-subtle transition-colors",
          row.present ? "cursor-grab hover:text-fg active:cursor-grabbing" : "cursor-default opacity-0",
        )}
      >
        <GripVerticalIcon className="size-4" />
      </button>

      <span className="min-w-0 flex-1">
        <span className="block text-body text-fg">{row.label}</span>
        <span className="block text-caption1 text-fg-subtle truncate">{row.hint}</span>
      </span>

      <Switch checked={row.present} onCheckedChange={onToggle} aria-label={`Show ${row.label} on Home`} />
    </div>
  );
}

export function HomeEditor({
  rows,
  sensors,
  onToggle,
  onReorder,
}: {
  rows: readonly HomeCardRow[];
  sensors: SensorDescriptor<SensorOptions>[];
  onToggle: (type: HomeCardType) => void;
  /** Both indexes are into the PRESENT cards, which is what the list shows. */
  onReorder: (from: number, to: number) => void;
}) {
  const present = rows.filter((r) => r.present);

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = present.map((r) => r.type as string);
    onReorder(ids.indexOf(active.id as string), ids.indexOf(over.id as string));
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption1 text-fg-subtle">
        Switch a card off to take it off Home, and drag to reorder. Home has no
        canvas — the cards stack top to bottom, whatever the window is.
      </p>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        {/* Only the present cards are sortable. The switched-off ones render
            below, outside the context, so dropping onto one is not a gesture
            that appears to do something and does not. */}
        <SortableContext items={present.map((r) => r.type)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {present.map((r) => (
              <CardRow key={r.type} row={r} onToggle={() => onToggle(r.type)} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {rows.some((r) => !r.present) && (
        <>
          <p className="pt-2 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            Not on Home
          </p>
          <div className="flex flex-col gap-2">
            {rows
              .filter((r) => !r.present)
              .map((r) => (
                <CardRow key={r.type} row={r} onToggle={() => onToggle(r.type)} />
              ))}
          </div>
        </>
      )}

    </div>
  );
}
