// Arranging the context bar, the way macOS lets you arrange a toolbar.
//
// The list-with-checkboxes this replaces could describe an arrangement but never
// show one: you dragged rows in a COLUMN and inferred a horizontal strip from
// them, and the row that set the left/right split had to explain itself in prose
// because there was nothing to look at.
//
// So the bar itself is the editing surface. The strip in the middle is the REAL
// bar — same layout constants, same items, rendered from the same live data by
// the same function — and you drag items into it, along it, and out of it. What
// you are looking at is what will be above every page.
//
// THE DRAG IS GEOMETRY, NOT DROPPABLES. No SortableContext, no collision
// detection, no `over`. Everything comes from the pointer and the rows' own
// midpoints, because the droppable-based version was wrong three ways at once:
// `over` is never null under closestCenter, so nothing could be dropped OUT;
// sortable rows shifted under the pointer while it was trying to aim at them;
// and "the row you are over" cannot tell the left half of a wide item from the
// right half, so every drop landed before it and the whole thing read as a
// stubborn leftward bias. Rows hold still now, the caret says where the thing
// will land, and the maths lives in bar-drop.ts where it can be tested.
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
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";

import {
  BAR_ITEMS,
  BAR_SPACE,
  BAR_SPACE_ITEM,
  BAR_SPACER,
  BAR_SPACER_ITEM,
  isBarGap,
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
import { dropPoint, droppedOnBar, gapFromMidpoints } from "./bar-drop";
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

const ALL_IDS = Object.keys(BAR_ITEMS) as BarItemId[];

/** A row being edited. Spacers repeat, so a row needs an identity of its own —
 *  drags are addressed by id, and two rows sharing one swap with themselves. */
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
  if (id === BAR_SPACER) return BAR_SPACER_ITEM;
  if (id === BAR_SPACE) return BAR_SPACE_ITEM;
  return BAR_ITEMS[id];
}

/**
 * Nothing in here may be selectable.
 *
 * A drag that crosses text starts a native selection, and the browser gives the
 * mouseup to THAT rather than to the drag — so releasing over the palette left
 * the ghost stuck to the pointer with no way to put it down.
 */
const NO_SELECT = "select-none";

/** Where the thing you are dragging will land. */
function Caret() {
  return (
    <span aria-hidden="true" className="-mx-1 h-6 w-0.5 shrink-0 self-center rounded-full bg-accent" />
  );
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
      // aria-disabled, NOT disabled. A disabled button computes
      // `pointer-events: none`, which makes it a hole the pointer falls
      // through — and a drag released over a hole has nothing to release
      // onto. It also keeps the tile focusable, so a keyboard user can still
      // read why it is unavailable.
      aria-disabled={used || undefined}
      title={item.hint}
      aria-label={used ? `${item.label} — already in the bar` : `Add ${item.label}`}
      className={cn(
        "group flex w-[104px] flex-col items-center gap-1.5 rounded-lg p-2 text-center",
        "outline-none focus-visible:ring-2 focus-visible:ring-accent",
        NO_SELECT,
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
function BarRow({ row, ctx, onRemove }: { row: Row; ctx: BarItemContext; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.key,
    data: { from: "bar" },
  });
  const label = presentation(row.id).label;

  return (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // Measured by key while a drag is running. The row does NOT move under the
      // pointer — the overlay is the feedback and the caret is the target, so
      // what you are aiming at stays where you saw it.
      data-row-key={row.key}
      className={cn(
        "group relative cursor-grab rounded-md outline-none active:cursor-grabbing",
        "ring-offset-2 ring-offset-bg focus-visible:ring-2 focus-visible:ring-accent",
        "hover:bg-fill touch-pan-y",
        NO_SELECT,
        // A gap has no content, so it needs a width of its own to be grabbable
        // at all. The flexible one grows from there like the real one does; the
        // fixed one is shown at exactly the width it will be.
        row.id === BAR_SPACER ? "min-w-10 flex-1 self-stretch"
          : row.id === BAR_SPACE ? "w-8 shrink-0 self-stretch"
          : BAR_ITEM_CLASS,
        isDragging && "opacity-40",
      )}
      aria-label={`${label} — drag to move`}
    >
      {isBarGap(row.id) ? (
        // Visible only in here. In the bar itself a gap is nothing at all.
        <span className="pointer-events-none flex h-full items-center justify-center">
          <span
            className={cn(
              "h-4 w-full rounded-[3px] border border-dashed border-line-strong",
              // Solid for the fixed one: it is a fixed thing, and the two have
              // to be told apart at a glance once both are in the bar.
              row.id === BAR_SPACE && "border-solid bg-fill",
            )}
          />
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
  const barRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState<BarRowId | null>(null);

  // The rows staying put during this drag, measured once at drag start. Safe to
  // cache precisely because nothing shifts mid-drag.
  const still = useRef<{ keys: string[]; mids: number[] }>({ keys: [], mids: [] });
  // Where the caret is drawn: a row key, "end", or null for "releasing here
  // places nothing". Held as the RESOLVED target rather than a gap index so
  // rendering never has to read `still`, which is a ref.
  const [caret, setCaret] = useState<string | null>(null);
  // Whether the last pointer position was a place. Deliberately NOT cleared by
  // handleDragEnd: the overlay reads its drop animation as it unmounts, and by
  // then the caret is already gone. Reset at the start of the next drag.
  const [wasPlaceable, setWasPlaceable] = useState(false);

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

  const used = new Set(rows.map((r) => r.id));

  /** Every change goes through here, so nothing reaches the server unnormalised
   *  and the preview shows what was actually saved. */
  function commit(next: Row[]) {
    setRows(next);
    void setBarItems(queryClient, normalizeBarRows(next.map((r) => r.id)));
  }

  function add(id: BarRowId, at = rows.length) {
    const next = [...rows];
    next.splice(at, 0, { key: nextKey.current(), id });
    commit(next);
  }

  /** The gap this pointer position means, or null for "not a place".
   *
   *  ONE function, used by both the caret and the drop, so the caret cannot
   *  promise a position the drop does not honour. */
  function gapFor(e: DragMoveEvent | DragEndEvent): number | null {
    if (!droppedOnBar(e, barRef.current?.getBoundingClientRect() ?? null)) return null;
    const p = dropPoint(e);
    return p ? gapFromMidpoints(still.current.mids, p.x) : null;
  }

  function handleDragStart(e: DragStartEvent) {
    const data = e.active.data.current;
    const activeKey = data?.from === "bar" ? String(e.active.id) : null;
    // Measure the rows that are STAYING, in display order. The dragged row is
    // excluded because it is leaving its slot — which is what lets one gap rule
    // serve a reorder and an insert alike, with no off-by-one between them.
    const keys: string[] = [];
    const mids: number[] = [];
    for (const n of barRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? []) {
      const k = n.dataset.rowKey;
      if (!k || k === activeKey) continue;
      const r = n.getBoundingClientRect();
      keys.push(k);
      mids.push(r.left + r.width / 2);
    }
    still.current = { keys, mids };
    setWasPlaceable(false);
    setDragging((data?.id as BarRowId | undefined) ?? rows.find((r) => r.key === e.active.id)?.id ?? null);
  }

  function handleDragMove(e: DragMoveEvent) {
    const g = gapFor(e);
    setWasPlaceable(g !== null);
    setCaret(g === null ? null : (still.current.keys[g] ?? "end"));
  }

  function handleDragEnd(e: DragEndEvent) {
    const g = gapFor(e);
    setDragging(null);
    setCaret(null);

    const fromPalette = e.active.data.current?.from === "palette";
    if (g === null) {
      // Not a place. A row dragged out of the bar goes; a tile flies home.
      if (!fromPalette) commit(rows.filter((r) => r.key !== e.active.id));
      return;
    }

    const staying = still.current.keys
      .map((k) => rows.find((r) => r.key === k))
      .filter((r): r is Row => r !== undefined);
    const moved: Row | undefined = fromPalette
      ? { key: nextKey.current(), id: e.active.data.current?.id as BarRowId }
      : rows.find((r) => r.key === e.active.id);
    if (!moved) return;

    const next = [...staying];
    next.splice(g, 0, moved);
    commit(next);
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
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setDragging(null);
            setCaret(null);
            setWasPlaceable(false);
          }}
        >
          <div
            className={cn(
              "mt-4 flex flex-wrap justify-center gap-1 rounded-xl border border-line bg-surface p-3",
              NO_SELECT,
            )}
          >
            {[...ALL_IDS, BAR_SPACE, BAR_SPACER].map((id) => (
              <PaletteTile
                key={id}
                id={id}
                // Neither gap is ever "used up" — the whole point of both is
                // being able to place more than one.
                used={!isBarGap(id) && used.has(id)}
                onAdd={() => add(id)}
              />
            ))}
          </div>

          <p className="mt-5 text-caption1 text-fg-subtle">The bar, as it will appear:</p>
          <div
            ref={barRef}
            className={cn(
              "mt-1.5 rounded-xl border border-line-strong bg-bg",
              BAR_STRIP_CLASS,
              "min-h-11 sm:h-auto sm:min-h-11",
              NO_SELECT,
            )}
          >
            {rows.length === 0 && !dragging && (
              <span className="text-footnote text-fg-subtle">Drag something in.</span>
            )}
            {rows.map((row) => (
              <Fragment key={row.key}>
                {caret === row.key && <Caret />}
                <BarRow
                  row={row}
                  ctx={ctx}
                  onRemove={() => commit(rows.filter((r) => r.key !== row.key))}
                />
              </Fragment>
            ))}
            {caret === "end" && <Caret />}
          </div>

          {/* Portalled to the body, NOT left inside the dialog.
              DragOverlay positions itself `fixed`, and the dialog is centred
              with Tailwind's `translate` utilities — which, exactly like
              `transform`, make a containing block for fixed descendants. Left
              in place the ghost was offset by half the dialog, appearing far
              below the pointer and impossible to aim with.

              dropAnimation ONLY when the drop was not a place: the ghost flies
              back where it came from, which is what "that did not take" looks
              like. On a real drop it would instead animate towards a slot the
              item already occupies. */}
          {createPortal(
            <DragOverlay dropAnimation={wasPlaceable ? null : undefined}>
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
