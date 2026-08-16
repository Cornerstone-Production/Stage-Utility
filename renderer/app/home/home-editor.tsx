// Home's editor, in Home's tab.
//
// Phase 6 sent this to the canvas editor at /screens/home/edit. Nobody places
// pixels on a home dashboard — it is a stack of cards you either want or you do
// not — so this is the whole editor: a switch and a drag handle per card.
//
// It replaces the page in place rather than opening beside it. A split view
// would halve the cards it is editing, and the list is short enough to hold in
// your head; Done puts the real page back.

import type { CSSProperties } from "react";
import { DndContext, closestCenter, type DragEndEvent, type SensorDescriptor, type SensorOptions } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";

import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/cn";
import type { HomeCardRow, HomeCardType } from "./home-cards";

function CardRow({
  row,
  onToggle,
}: {
  row: HomeCardRow;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.type,
    // A card that is switched off has no position on the page, so there is
    // nothing to reorder it against.
    disabled: !row.present,
  });
  const { role: _dragRole, tabIndex: _dragTabIndex, ...dragA11y } = attributes;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

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
  strays,
  sensors,
  onToggle,
  onReorder,
  onClearStrays,
}: {
  rows: readonly HomeCardRow[];
  /** Registry labels for objects in Home's layout that Home does not draw. */
  strays: readonly string[];
  sensors: SensorDescriptor<SensorOptions>[];
  onToggle: (type: HomeCardType) => void;
  /** Both indexes are into the PRESENT cards, which is what the list shows. */
  onReorder: (from: number, to: number) => void;
  onClearStrays: () => void;
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

      {strays.length > 0 && (
        // Only reachable from an install that edited Home on the canvas before
        // this existed. Named rather than dropped on the quiet: the objects are
        // still in the file, and this says so and offers the one action.
        <div className="mt-2 rounded-xl border border-line bg-surface px-3 py-2.5">
          <p className="text-body text-fg">Left over from the old canvas editor</p>
          <p className="mt-0.5 text-caption1 text-fg-subtle">
            {strays.join(", ")} — still stored, but Home does not draw{" "}
            {strays.length === 1 ? "it" : "them"}.
          </p>
          <button
            type="button"
            onClick={onClearStrays}
            className="mt-2 text-caption1 text-accent hover:underline"
          >
            Remove {strays.length === 1 ? "it" : "them"}
          </button>
        </div>
      )}
    </div>
  );
}
