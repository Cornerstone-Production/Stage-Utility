// Arranging the context bar, the way macOS lets you arrange a toolbar.
//
// The list-with-checkboxes this replaces could describe an arrangement but never
// show one: you dragged rows in a column and inferred a horizontal strip from
// them, and the row that set the left/right split had to explain itself in prose
// because there was nothing to look at.
//
// So the bar itself is the editing surface. The strip in the middle is the REAL
// bar — same layout constants, same items, rendered from the same live data by
// the same function — and you drag items into it, along it, and out of it. What
// you are looking at is what will be above every page.
//
// Deliberately unlike macOS in two places. There is no fixed-width Space, only
// the flexible one: our items already carry their own gap, and a second kind of
// nothing is a concept to explain for no gain. And the default set is a button
// rather than a draggable block — dragging it in macOS replaces the whole
// toolbar, which is what a button does, more obviously and from a keyboard.

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";

import {
  BAR_ITEMS,
  BAR_SPACER,
  BAR_SPACER_ITEM,
  DEFAULT_BAR_ORDER,
  normalizeBarRows,
  type BarItem,
  type BarItemId,
  type BarRowId,
} from "./bar-items";
import {
  BAR_ITEM_CLASS,
  BAR_STRIP_CLASS,
  renderBarItem,
  useBarContext,
  type BarItemContext,
} from "./context-bar";
import { droppedOnBar, insertionGap } from "./bar-drop";
import { setBarItems } from "./set-bar-items";
import {
  Button,
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../components/ui";
import { cn } from "../lib/cn";
import { useSortableRow } from "../lib/use-sortable-row";

const ALL_IDS = Object.keys(BAR_ITEMS) as BarItemId[];

/** A row being edited. Spacers repeat, so a row needs an identity of its own —
 *  dnd-kit addresses everything by id, and two rows sharing one swap places with
 *  themselves. */
interface Row {
  key: string;
  id: BarRowId;
}

/** Row keys, unique per dialog session.
 *
 *  A counter, not crypto.randomUUID: that is undefined outside a secure context
 *  and production is served over plain HTTP, where it would throw on open. */
function makeKeyer(): () => string {
  let n = 0;
  return () => `row${++n}`;
}

function presentation(id: BarRowId): Omit<BarItem, "id"> {
  return id === BAR_SPACER ? BAR_SPACER_ITEM : BAR_ITEMS[id];
}

/** A tile in the palette. Drag it into the bar, or click to append it. */
function PaletteTile({
  id,
  used,
  onAdd,
}: {
  id: BarRowId;
  /** Already in the bar. Dimmed and undraggable, as macOS does it. */
  used: boolean;
  onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${id}`,
    data: { from: "palette", id },
    disabled: used,
  });
  const item = presentation(id);
  const Icon = item.icon;

  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      type="button"
      // Click is the accessible path to the same thing. Dragging is a mouse
      // gesture; adding an item must not require one.
      onClick={used ? undefined : onAdd}
      disabled={used}
      title={item.hint}
      aria-label={used ? `${item.label} — already in the bar` : `Add ${item.label}`}
      className={cn(
        "group flex w-[104px] flex-col items-center gap-1.5 rounded-lg p-2 text-center",
        "outline-none focus-visible:ring-2 focus-visible:ring-accent",
        used ? "cursor-default opacity-45" : "cursor-grab active:cursor-grabbing hover:bg-fill",
        isDragging && "opacity-30",
      )}
    >
      <span
        className={cn(
          "flex size-11 items-center justify-center rounded-full border border-line-strong",
          !used && "group-hover:border-accent group-hover:text-accent",
        )}
      >
        <Icon className="size-5" />
      </span>
      <span className="text-caption2 leading-tight text-fg-muted">{item.label}</span>
    </button>
  );
}

/** One row inside the bar being edited. */
function BarRow({
  row,
  ctx,
  onRemove,
}: {
  row: Row;
  ctx: BarItemContext;
  onRemove: () => void;
}) {
  const { setNodeRef, style, attributes, listeners, isDragging } = useSortableRow(row.key);
  const label = presentation(row.id).label;

  return (
    <span
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      // A spacer has no content, so it needs a width of its own to be grabbable
      // at all — it grows from there like the real one does.
      className={cn(
        "group relative cursor-grab rounded-md outline-none active:cursor-grabbing",
        "ring-offset-2 ring-offset-bg focus-visible:ring-2 focus-visible:ring-accent",
        "hover:bg-fill",
        row.id === BAR_SPACER ? "min-w-10 flex-1 self-stretch" : BAR_ITEM_CLASS,
        isDragging && "opacity-40",
      )}
      aria-label={`${label} — drag to move`}
    >
      {row.id === BAR_SPACER ? (
        // Visible only in here. In the bar itself a spacer is nothing at all.
        <span className="pointer-events-none flex h-full items-center justify-center">
          <span className="h-4 w-full rounded-[3px] border border-dashed border-line-strong" />
        </span>
      ) : (
        renderBarItem(row.id, ctx)
      )}

      <button
        type="button"
        // Drag-out is the gesture; this is the same act for a pointer that
        // cannot drag and for a keyboard, which has no drag at all.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className={cn(
          "absolute -right-1.5 -top-1.5 hidden size-4 items-center justify-center rounded-full",
          "border border-line-strong bg-bg text-fg-muted",
          "group-hover:flex group-focus-within:flex hover:text-danger-11",
        )}
      >
        <XIcon className="size-2.5" />
      </button>
    </span>
  );
}

/** Where the thing you are dragging will land. */
function Caret() {
  return (
    <span
      aria-hidden="true"
      className="-mx-1 h-6 w-0.5 shrink-0 self-center rounded-full bg-accent"
    />
  );
}

export function BarConfigurator({
  open,
  onOpenChange,
  rows: saved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The bar as it stands, already normalised by `visibleBarItems`. */
  rows: readonly BarRowId[];
}) {
  const queryClient = useQueryClient();
  const ctx = useBarContext();
  const nextKey = useRef(makeKeyer());
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState<BarRowId | null>(null);
  // The gap the dragged thing would land in — the caret is drawn before
  // rows[gap]. null while the pointer is somewhere that would not insert.
  const [gap, setGap] = useState<number | null>(null);

  // Seeded when the dialog opens, not on every change to `saved` — otherwise the
  // save this dialog just made would flow back in and re-seed mid-edit.
  useEffect(() => {
    if (open) setRows(saved.map((id) => ({ key: nextKey.current(), id })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sensors = useSensors(
    // The same pair as every other draggable surface here. Never a lone
    // PointerSensor, which claims the gesture on touch-down and leaves the
    // dialog unscrollable on a phone.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const { setNodeRef: setDroppableRef, isOver } = useDroppable({ id: "bar" });
  const barRef = useRef<HTMLDivElement | null>(null);
  const used = new Set(rows.map((r) => r.id));

  function setBarRef(el: HTMLDivElement | null) {
    barRef.current = el;
    setDroppableRef(el);
  }

  /** Every change goes through here, so nothing reaches the server unnormalised
   *  and the preview shows what was actually saved. */
  function commit(next: Row[]) {
    setRows(next);
    const ids = normalizeBarRows(next.map((r) => r.id));
    void setBarItems(queryClient, ids);
  }

  function add(id: BarRowId, at = rows.length) {
    const next = [...rows];
    next.splice(at, 0, { key: nextKey.current(), id });
    commit(next);
  }

  // onDragMove, not onDragOver: the caret has to vanish the moment the pointer
  // leaves the bar, and `over` does not change when it does — closestCenter is
  // still happily reporting the nearest row. No caret is the honest signal that
  // letting go here removes rather than places.
  function handleDragMove(e: DragMoveEvent) {
    if (!droppedOnBar(e, barRef.current?.getBoundingClientRect() ?? null)) {
      setGap(null);
      return;
    }
    setGap(insertionGap(rows.map((r) => r.key), String(e.active.id), e.over ? String(e.over.id) : null));
  }

  function handleDragStart(e: DragStartEvent) {
    const data = e.active.data.current;
    setDragging((data?.id as BarRowId | undefined) ?? rows.find((r) => r.key === e.active.id)?.id ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setDragging(null);
    setGap(null);
    const { active, over } = e;
    const onBar = droppedOnBar(e, barRef.current?.getBoundingClientRect() ?? null);

    if (active.data.current?.from === "palette") {
      // Let go somewhere else in the dialog: nothing was asked for.
      if (!onBar) return;
      const at = over && over.id !== "bar" ? rows.findIndex((r) => r.key === over.id) : -1;
      add(active.data.current.id as BarRowId, at === -1 ? rows.length : at);
      return;
    }

    // Dragged out of the bar — macOS's "poof".
    if (!onBar) {
      commit(rows.filter((r) => r.key !== active.id));
      return;
    }
    if (!over || over.id === active.id || over.id === "bar") return;
    const oldIndex = rows.findIndex((r) => r.key === active.id);
    const newIndex = rows.findIndex((r) => r.key === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    commit(arrayMove(rows, oldIndex, newIndex));
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Configure the context bar</DialogTitle>
          <DialogDescription>
            Drag items into the bar. Drag one out to remove it. Everyone sees the same bar.
          </DialogDescription>
        </DialogHeader>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={() => { setDragging(null); setGap(null); }}
        >
          <div className="mt-4 flex flex-wrap justify-center gap-1 rounded-xl border border-line bg-surface p-3">
            {[...ALL_IDS, BAR_SPACER].map((id) => (
              <PaletteTile
                key={id}
                id={id}
                // A spacer is never "used up" — the whole point is having more
                // than one.
                used={id !== BAR_SPACER && used.has(id)}
                onAdd={() => add(id)}
              />
            ))}
          </div>

          <p className="mt-5 text-caption1 text-fg-subtle">The bar, as it will appear:</p>
          <SortableContext items={rows.map((r) => r.key)} strategy={horizontalListSortingStrategy}>
            <div
              ref={setBarRef}
              className={cn(
                "mt-1.5 rounded-xl border bg-bg",
                BAR_STRIP_CLASS,
                "min-h-11 sm:h-auto sm:min-h-11",
                isOver ? "border-accent" : "border-line-strong",
              )}
            >
              {rows.length === 0 && (
                <span className="text-footnote text-fg-subtle">Drag something in.</span>
              )}
              {rows.map((row, i) => (
                <Fragment key={row.key}>
                  {gap === i && <Caret />}
                  <BarRow
                    row={row}
                    ctx={ctx}
                    onRemove={() => commit(rows.filter((r) => r.key !== row.key))}
                  />
                </Fragment>
              ))}
              {gap === rows.length && <Caret />}
            </div>
          </SortableContext>

          {/* Portalled to the body, NOT left inside the dialog.
              DragOverlay positions itself `fixed`, and the dialog is centred
              with Tailwind's `translate` utilities — which, exactly like
              `transform`, make a containing block for fixed descendants. Left
              in place the ghost was offset by half the dialog, appearing far
              below the pointer and making the tile impossible to aim. */}
          {createPortal(
            <DragOverlay dropAnimation={null}>
              {dragging && (
                // w-max and nowrap, and NOT an inline span: dnd-kit sizes the
                // overlay wrapper to the node the drag started from — 104px for
                // a palette tile — so a longer label wrapped, and an inline
                // box's border breaks across lines. The pill fragmented into
                // two half-bordered pieces mid-drag.
                <span className="inline-flex w-max items-center whitespace-nowrap rounded-md border border-accent bg-popover px-2 py-1 text-caption2 text-fg shadow-xl">
                  {presentation(dragging).label}
                </span>
              )}
            </DragOverlay>,
            document.body,
          )}
        </DndContext>

        <div className="mt-5 flex items-center justify-between gap-3">
          <Button
            variant="transparent"
            size="small"
            onClick={() => commit(DEFAULT_BAR_ORDER.map((id) => ({ key: nextKey.current(), id })))}
          >
            Use the default set
          </Button>
          <Button variant="accent" size="small" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
