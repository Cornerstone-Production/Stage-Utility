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
import { MonitorIcon, SmartphoneIcon, XIcon } from "lucide-react";

import {
  BAR_ITEMS,
  BAR_SPACE,
  BAR_SPACE_ITEM,
  BAR_SPACER,
  BAR_SPACER_ITEM,
  BAR_PROSE_ITEMS,
  isBarGap,
  isProseItem,
  hasMobileBar,
  phoneShowsEditedSet,
  visibleBarItems,
  DEFAULT_BAR_ORDER,
  normalizeBarRows,
  type BarItem,
  type BarItemId,
  type BarRowId,
} from "./bar-items";
import { useBarFit } from "./bar-fit";
import { MOBILE_MAX_WIDTH } from "../lib/use-media-query";
import {
  BAR_ITEM_CLASS,
  BAR_STRIP_CLASS,
  BarSpacerEl,
  BarSpaceEl,
  renderBarItem,
  useBarContext,
  type BarItemContext,
} from "./context-bar";
import { dropPoint, droppedOnBar, gapFromMidpoints } from "./bar-drop";
import { setBarItems, type BarSet } from "./set-bar-items";
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

/**
 * One row inside the bar being edited.
 *
 * The hover state is an absolutely-positioned pill BEHIND the content, not a
 * background on the row itself. A background on the row is the row's exact
 * bounds, which for a text reading is a rectangle hugging the glyphs and for a
 * stretched gap was a slab taller than everything beside it — the two never
 * lined up. Sitting behind, it can have its own uniform height and a little
 * breathing room without moving anything.
 */
function BarRow({ row, ctx, onRemove }: { row: Row; ctx: BarItemContext; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.key,
    data: { from: "bar" },
  });
  const label = presentation(row.id).label;
  const gap = isBarGap(row.id);

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
        "group relative flex cursor-grab items-center outline-none active:cursor-grabbing",
        "touch-pan-y",
        NO_SELECT,
        // A gap has no content, so it needs a width of its own to be grabbable
        // at all. The flexible one grows, as the real one does.
        //
        // The fixed one is shown at its true 24px WITHOUT the negative margins
        // it carries in the bar. Those exist so the width is the whitespace
        // between two readings; in here they dragged the marker into the
        // neighbouring gap and left it flush against the text next to it, with
        // nothing to separate them. The block you see is the size you get.
        row.id === BAR_SPACER ? "min-w-10 flex-1" : row.id === BAR_SPACE ? "w-6 shrink-0" : "shrink-0",
        isDragging && "opacity-40",
      )}
      aria-label={`${label} — drag to move`}
    >
      {/* One shape and one height for every row, so a strip of them reads as a
          row of chips rather than as rectangles of assorted sizes. */}
      <span
        aria-hidden="true"
        className={cn(
          // 2px, not 4px. The strip in this dialog carries the bar's REAL 12px
          // gap so the fit it shows is the fit you get; at 4px a side two pills
          // left only 4px between them and a row of them read as one continuous
          // block. Widening the gap instead — which is what this used to do —
          // made every arrangement look roomier in here than it is on the page.
          "pointer-events-none absolute -inset-y-1 -inset-x-0.5 rounded-md bg-fill",
          "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -inset-y-1 -inset-x-0.5 rounded-md ring-accent",
          "group-focus-visible:ring-2",
        )}
      />

      <span className={cn("relative flex h-5 w-full items-center", !gap && "gap-2.5")}>
        {gap ? (
          // Visible only in here. In the bar itself a gap is nothing at all.
          <span
            className={cn(
              "h-3.5 w-full rounded-[3px] border border-dashed border-line-strong",
              // Solid for the fixed one: it is a fixed thing, and the two have
              // to be told apart at a glance once both are in the bar.
              row.id === BAR_SPACE && "border-solid bg-fill",
            )}
          />
        ) : (
          // `preview: true`. In here a row is a thing you drag, so an item that
          // is a real control in the bar renders as a plain reading: a live
          // score capsule would toggle the panel behind this dialog on the very
          // press that was reaching for the row.
          //
          // NAME IT when it renders nothing. The score capsule is allowed to be
          // invisible in the bar (see BarItem.canBeEmpty), and out of season it
          // always is — but a row with no content is a chip with no width and no
          // label, so the operator could neither see the item they placed nor
          // get hold of it to move it. In here the fallback is the item's name,
          // which is what you are dragging anyway.
          (renderBarItem(row.id as BarItemId, { ...ctx, preview: true }) ?? (
            <span className="text-footnote text-fg-subtle truncate">{label}</span>
          ))
        )}
      </span>

      <button
        type="button"
        // Drag-out is the gesture; this is the same act for a pointer that
        // cannot drag and for a keyboard, which has no drag at all.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className={cn(
          "absolute -right-2 -top-2 z-10 hidden size-4 items-center justify-center rounded-full",
          "border border-line-strong bg-bg text-fg-muted shadow-sm",
          "group-hover:flex group-focus-within:flex hover:text-danger-11 hover:border-danger-11",
        )}
      >
        <XIcon className="size-2.5" />
      </button>
    </span>
  );
}

/** The narrowest screen the bar promises to fit on. Anything smaller than this
 *  is not a phone anybody is running an operator app on. */
const NARROWEST = 320;

/** What the phone tab holds its preview to: a common phone, not the narrowest
 *  one. The narrowest is what the sentence under the strip reports on, measured
 *  by NarrowProbe — showing the worst case as the preview would misrepresent
 *  every arrangement to make one of them honest. */
const PHONE_PREVIEW = 390;

/** "the plan", "the plan and the current item". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The same arrangement, laid out off-screen at 320px, so the dialog can say what
 * will happen on the narrowest phone rather than only what is happening in here.
 *
 * MEASURED, NOT PREDICTED. The alternative is a table of per-item widths kept in
 * sync by hand with the type scale, the icon set and whatever the plan happens to
 * be called this week — three things that move independently and one of which is
 * the operator's own data. This lays the real items out with the real strings and
 * reads the rung they land on.
 *
 * `aria-hidden` and inert to a screen reader: it is a ruler, not a second bar.
 * The reading it produces is spoken by the sentence beside the preview instead.
 */
function NarrowProbe({
  rows,
  ctx,
  onFit,
}: {
  rows: readonly BarRowId[];
  ctx: BarItemContext;
  onFit: (fit: { over: number; cut: string[] }) => void;
}) {
  const { ref, over } = useBarFit<HTMLDivElement>();

  // WHICH PROSE IS ACTUALLY CUT, read off the elements — not deduced from the
  // rung. Reaching the floor is not the same fact as losing a word: the floor
  // lets prose give way, and prose gives way only as far as it has to, so an
  // arrangement can land there and still show every title in full. Warning off
  // the rung would have cried wolf on exactly the arrangements that are fine.
  const last = useRef("");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cut = [...el.querySelectorAll<HTMLElement>("[data-prose]")]
      .filter((n) => {
        // The reading itself, not the item's box — the box is what shrank, and
        // the reading is what got an ellipsis. A `plan` item with no plan loaded
        // has no prose element at all and cannot be cut.
        const reading = n.querySelector(".bar-prose");
        return reading !== null && reading.scrollWidth > reading.clientWidth + 0.5;
      })
      .map((n) => n.dataset.prose ?? "");
    const key = `${over}|${cut.join(",")}`;
    if (key === last.current) return;
    last.current = key;
    onFit({ over, cut });
    // No dependency list on purpose: a re-fit is exactly when this has to run
    // again, and the widths it reads change with the rung AND with the content.
    // The key comparison above is what keeps that from being a render loop.
  });
  return (
    <div
      aria-hidden="true"
      // Off-screen rather than `visibility: hidden` or zero-height: the strip has
      // to be laid out for scrollWidth to mean anything, and a display:none
      // subtree has no layout at all.
      className="pointer-events-none fixed -left-[9999px] top-0"
      style={{ width: NARROWEST }}
    >
      <div ref={ref} className={BAR_STRIP_CLASS}>
        <BarStripRows rows={rows} ctx={ctx} />
      </div>
    </div>
  );
}

/** The rows of a strip, rendered the way the real bar renders them. Shared so a
 *  preview and a probe cannot lay out differently from the bar they speak for. */
function BarStripRows({ rows, ctx }: { rows: readonly BarRowId[]; ctx: BarItemContext }) {
  return (
    <>
      {rows.map((id, i) => {
        if (id === BAR_SPACER) return <BarSpacerEl key={`${id}-${i}`} />;
        if (id === BAR_SPACE) return <BarSpaceEl key={`${id}-${i}`} />;
        const content = renderBarItem(id as BarItemId, { ...ctx, preview: true });
        if (content === null) return null;
        return (
          // The name goes on the ITEM's own box, not on a wrapper inside it, and
          // that is load-bearing rather than tidy: the floor is expressed as
          // `.bar-item:has(> .bar-prose)`, so anything between the two — even a
          // `display: contents` span, which changes no layout — stops the item
          // being allowed to shrink. A first pass did exactly that, and the probe
          // reported an arrangement 2px too long that in the real bar fits.
          <span key={id} className={BAR_ITEM_CLASS} data-prose={isProseItem(id) ? BAR_PROSE_ITEMS[id] : undefined}>
            {content}
          </span>
        );
      })}
    </>
  );
}

/**
 * Which of the two sets is being edited.
 *
 * A segmented switch rather than two tabs or a side-by-side. Side-by-side does
 * not survive the phone, and the phone is where the mobile set's effect is
 * actually seen — an operator arranging it on a desktop is guessing. Two screens
 * would make them two tools; this is one tool pointed at one of two things, which
 * is what it is.
 *
 * The active segment is RAISED, not merely tinted. Which set you are editing is
 * the one thing in this dialog you cannot afford to be unsure about — a save goes
 * somewhere either way — so it is carried by fill and elevation rather than by a
 * colour a glance can miss.
 */
function SetSwitch({ value, onChange }: { value: BarSet; onChange: (v: BarSet) => void }) {
  const options: { id: BarSet; label: string; Icon: typeof MonitorIcon }[] = [
    { id: "desktop", label: "Desktop", Icon: MonitorIcon },
    { id: "mobile", label: "Phone", Icon: SmartphoneIcon },
  ];
  return (
    <div role="group" aria-label="Which bar to edit" className="flex items-center gap-px rounded-lg bg-accent/12 p-0.5">
      {options.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => value !== id && onChange(id)}
          aria-pressed={value === id}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-3 py-1 text-caption1 transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-focus",
            value === id
              ? "bg-bg font-semibold text-fg shadow-sm"
              : "font-medium text-fg-subtle hover:text-fg",
          )}
        >
          {/* THE ICON CARRIES THE STATE, not the fill alone. Focus draws a ring
              the same shape and size as the raised chip, so on the first pass a
              focused inactive segment read as the selected one — and which set
              you are editing is the one thing in this dialog you cannot afford
              to be unsure about. A colour the ring does not use settles it. */}
          <Icon className={cn("size-3.5", value === id && "text-accent")} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function BarConfigurator({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const ctx = useBarContext();
  const nextKey = useRef(makeKeyer());
  const barRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState<BarRowId | null>(null);
  const [editing, setEditing] = useState<BarSet>("desktop");
  const [narrow, setNarrow] = useState<{ over: number; cut: string[] }>({ over: 0, cut: [] });
  const { ref: previewRef } = useBarFit<HTMLDivElement>();

  const savedDesktop = ctx.state?.barItems;
  const savedMobile = ctx.state?.barMobileItems;
  // An unset phone set FOLLOWS the desktop one. So the phone tab opens showing
  // the desktop arrangement — which is what the phone is showing — rather than an
  // empty strip that would read as "you have no bar on a phone".
  const inheriting = editing === "mobile" && !hasMobileBar(savedMobile);
  const saved: readonly BarRowId[] = visibleBarItems(
    editing === "mobile" && !inheriting ? savedMobile : savedDesktop,
  );
  // Whether the 320px sentence is about this set at all — see
  // `phoneShowsEditedSet`. A desktop set the phone has stopped following is
  // never rendered on a phone, so there is nothing true to say about it here.
  const shownOnPhone = phoneShowsEditedSet(editing, savedMobile);

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

  // Seeded when the dialog opens and when the set being edited changes, NOT on
  // every change to `saved` — otherwise the save this dialog just made would flow
  // back in and re-seed mid-edit. That also means forking the phone off the
  // desktop set does not disturb the arrangement being edited: the first change
  // writes a mobile list, `inheriting` goes false, and `saved` changes under a
  // component that is deliberately not listening to it.
  useEffect(() => {
    if (open) setRows(saved.map((id) => ({ key: nextKey.current(), id })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const sensors = useSensors(
    // The same pair as every other draggable surface here. Never a lone
    // PointerSensor, which claims the gesture on touch-down and leaves the
    // dialog unscrollable on a phone.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const used = new Set(rows.map((r) => r.id));
  const rowIds = rows.map((r) => r.id);

  /**
   * What this arrangement costs on the narrowest phone, in a sentence, or null
   * if it costs nothing.
   *
   * Two different bad outcomes, and they want different advice. Either the strip
   * has prose on it and the prose gets cut — which is fixable by taking the
   * prose off, and is exactly what the phone's own set is for. Or it has none,
   * has already given up every word it has, and is simply longer than the screen
   * — which nothing but removing an item can fix, so it says the number and
   * says so.
   */
  function narrowWarning(): string | null {
    // Too long even with every word given up. Only reachable with no prose on
    // the strip to give way — all numbers and marks — so there is nothing to
    // take off but a whole item.
    if (narrow.over > 0) {
      return `On a ${NARROWEST}px phone this is ${narrow.over}px too long even with every word given up, so a reading at the end would be cut off. Take an item off the phone's bar.`;
    }
    if (narrow.cut.length === 0) return null;
    return `On a ${NARROWEST}px phone this runs out of room, and ${nameList(narrow.cut)} will be cut short. Take ${narrow.cut.length > 1 ? "one of them" : "it"} off the phone's bar to keep every reading whole.`;
  }
  const warning = shownOnPhone ? narrowWarning() : null;

  /** Every change goes through here, so nothing reaches the server unnormalised
   *  and the preview shows what was actually saved.
   *
   *  It writes to whichever set is being edited, and ONLY that one. A change made
   *  on the phone tab while it was still following the desktop bar is what forks
   *  it: there is no separate "give the phone its own set" step to forget, because
   *  wanting a different arrangement IS the thing that step would ask about.
   *
   *  A REFUSED WRITE PUTS THE ROWS BACK, and this is the only place that can.
   *  `setBarItems` is optimistic, but its optimism does not reach here: it writes
   *  `["stage:getState"]` in React Query, and every bar surface — this preview
   *  included — reads `useBarContext` -> `useDashboardState` -> `useStageState`,
   *  the independent SSE module store, which live-wiring only ever pushes INTO
   *  the cache. So the rollback the shared helper performs is invisible on this
   *  screen, and without the re-seed below the editor went on drawing a rejected
   *  arrangement under "The bar, as it will appear" while the real strip above
   *  showed the old one. `saved` is this render's reading of the server's
   *  arrangement, which is exactly what a refusal leaves in place. */
  async function commit(next: Row[]) {
    setRows(next);
    const ok = await setBarItems(queryClient, editing, normalizeBarRows(next.map((r) => r.id)));
    if (!ok) setRows(saved.map((id) => ({ key: nextKey.current(), id })));
  }

  /** Hand the phone back to the desktop bar. The one way out of a fork, and the
   *  reason forking on first edit is safe rather than a trap.
   *
   *  Rolls back for the same reason `commit` does: a refused write left the strip
   *  showing the desktop arrangement it had just failed to adopt. */
  async function followDesktop() {
    const before = rows;
    setRows(visibleBarItems(savedDesktop).map((id) => ({ key: nextKey.current(), id })));
    if (!(await setBarItems(queryClient, "mobile", []))) setRows(before);
  }

  function add(id: BarRowId, at = rows.length) {
    const next = [...rows];
    next.splice(at, 0, { key: nextKey.current(), id });
    void commit(next);
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
      if (!fromPalette) void commit(rows.filter((r) => r.key !== e.active.id));
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
    void commit(next);
  }

  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-sm:p-4">
        <DialogHeader>
          <DialogTitle>Configure the context bar</DialogTitle>
          {/* NO CLAIM ABOUT WHO SEES WHAT. This used to end "Everyone sees the
              same bar", which was true of one bar and is false of two: the
              switch immediately below hands a phone a set of its own. The
              switch and the line beside it already say which set is which, so
              this says what the dialog is for and stops. */}
          <DialogDescription>
            Drag items into the bar, along it to reorder, and out of it to remove.
          </DialogDescription>
        </DialogHeader>

        {/* The switch sits ABOVE the palette rather than beside the title,
            because it governs everything below it and nothing above it. On a
            phone it is also the first thing under the heading, which is where an
            operator who opened this dialog on the device they are configuring
            for will look. */}
        <div className="flex flex-wrap items-center gap-3">
          <SetSwitch value={editing} onChange={setEditing} />
          <p className="text-caption1 text-fg-subtle">
            {editing === "desktop"
              ? `Shown from ${MOBILE_MAX_WIDTH}px wide up.`
              : `Shown below ${MOBILE_MAX_WIDTH}px wide.`}
          </p>
        </div>

        {inheriting && (
          <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-caption1 text-fg-muted">
            The phone is showing the desktop bar. Change anything here and it gets
            a set of its own; until then the two stay together.
          </p>
        )}

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
          {/* Held to a phone's width on the phone tab. The strip inside is the
              REAL one — same class, same fit ladder — so an arrangement that has
              to give up its words does it here too, in front of the person
              choosing it, rather than for the first time on a phone. */}
          <div
            className="mt-1.5 w-full"
            style={editing === "mobile" ? { maxWidth: PHONE_PREVIEW } : undefined}
          >
            <div
              ref={(n) => {
                // TWO refs on one node, and they mean different things: the drag
                // maths needs the strip's box, and the fitter needs to write
                // `data-fit` on it. Assigned rather than composed because a
                // callback that returned the node would be read by dnd-kit as a
                // cleanup function.
                barRef.current = n;
                previewRef.current = n;
              }}
              // `bar-editor` is the ONE place the strip is allowed to scroll.
              // Not a softening of "the bar never scrolls" — this is not the bar,
              // it is the surface you drag on, and a row you cannot reach is a
              // row you cannot take off. The rung shown is still the real one:
              // scrolling changes what is reachable, not what fits. What the
              // phone will actually do is the sentence underneath, measured at
              // 320px, which is the number that matters and cannot be scrolled
              // away from.
              className={cn(
                "bar-editor rounded-xl border border-line-strong bg-bg",
                BAR_STRIP_CLASS,
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
                    onRemove={() => void commit(rows.filter((r) => r.key !== row.key))}
                  />
                </Fragment>
              ))}
              {caret === "end" && <Caret />}
            </div>
          </div>

          {/* WHAT HAPPENS AT THE NARROWEST WIDTH, measured rather than guessed —
              see NarrowProbe. The strip above is this dialog's width, which on a
              laptop is not a phone's; this sentence is the part that is about a
              phone. It only ever has bad news about prose, because prose is the
              only thing the ladder cannot fit without cutting — and being able to
              take prose off is the whole reason the phone has a set of its own.

              ONLY FOR A SET A PHONE ACTUALLY RENDERS. Both the probe and the
              sentence used to be unconditional, so a desktop set the phone had
              stopped following was measured at 320px and reported on — a width
              `barRowsFor` will never hand it, one line under "Shown from 640px
              wide up". */}
          {shownOnPhone && (
            <>
              <NarrowProbe rows={rowIds} ctx={ctx} onFit={setNarrow} />
              <p className={cn("mt-2 text-caption1", warning ? "text-warn-11" : "text-fg-subtle")}>
                {warning ?? `Fits on a ${NARROWEST}px phone with nothing cut.`}
              </p>
            </>
          )}

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

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="transparent"
              size="small"
              onClick={() =>
                void commit(DEFAULT_BAR_ORDER.map((id) => ({ key: nextKey.current(), id })))
              }
            >
              Use the default set
            </Button>
            {editing === "mobile" && !inheriting && (
              <Button variant="transparent" size="small" onClick={() => void followDesktop()}>
                Follow the desktop bar
              </Button>
            )}
          </div>
          <Button variant="accent" size="small" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
