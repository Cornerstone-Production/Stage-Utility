// Arranging the context bar in place, the way macOS lets you arrange a toolbar:
// the REAL bar above the real page is the editing surface, so what you see is
// what will be above every page. The drag is geometry, not droppables (see
// bar-drop.ts for why). The default set is a button rather than a draggable
// block, which is what replacing the whole bar is, more obviously and from a
// keyboard.
//
// The state lives in useBarEditor, held by the Customize provider, because the
// strip (in the context bar) and the tiles (in the tray) are in different parts
// of the page and one drag spans them.

import { Fragment, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useDraggable, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";

import {
  BAR_ITEMS,
  BAR_SPACE,
  BAR_SPACE_ITEM,
  BAR_SPACER,
  BAR_SPACER_ITEM,
  DEFAULT_BAR_ORDER,
  hasMobileBar,
  isBarGap,
  phoneShowsEditedSet,
  visibleBarItems,
  type BarItem,
  type BarItemId,
  type BarRowId,
} from "./bar-items";
import { useBarFit } from "./bar-fit";
import { BAR_STRIP_CLASS, BarStripRows, renderBarItem, type BarItemContext } from "./bar-strip";
import { droppedOnBar, gapFromBoxes, type MeasuredRow } from "./bar-drop";
import { dropPoint } from "./drag-geometry";
import { barListIo, barRowsOf, saveBarSet, sameBarIds, type BarEditRow, type BarSet } from "./set-bar-items";
import { useSavedList } from "./use-saved-list";
import type { ListStepResult } from "../lib/use-list-saves";
import { useLatestRef } from "../lib/use-latest-ref";
import { toast } from "../components/ui";
import { Caret, DRAGGABLE } from "./drag-parts";
import { useResyncOn } from "../lib/use-resync-on";
import { useStageState } from "../main/use-stage-state";
import { cn } from "../lib/cn";
import { joinWithAnd } from "../lib/join-with-and";

export const ALL_BAR_IDS = Object.keys(BAR_ITEMS) as BarItemId[];

/** What a bar drag carries: a row already in the strip, or a tile from the tray. */
export type BarDrag = { kind: "bar-chip"; key: string } | { kind: "bar-tile"; id: BarRowId };

export function isBarDrag(data: unknown): data is BarDrag {
  const kind = (data as { kind?: string } | undefined)?.kind;
  return kind === "bar-chip" || kind === "bar-tile";
}

export function presentation(id: BarRowId): Omit<BarItem, "id"> {
  if (id === BAR_SPACER) return BAR_SPACER_ITEM;
  if (id === BAR_SPACE) return BAR_SPACE_ITEM;
  return BAR_ITEMS[id];
}

/** The narrowest screen the bar promises to fit on. Anything smaller than this
 *  is not a phone anybody is running an operator app on. */
const NARROWEST = 320;

/** What the phone set is held to when edited on a wider screen: a common phone,
 *  not the narrowest one. The narrowest is what the warning reports on, measured
 *  by NarrowProbe; showing the worst case as the preview would misrepresent every
 *  arrangement to make one of them honest. */
const PHONE_PREVIEW = 390;

/**
 * What an arrangement costs on the narrowest phone, in a sentence, or null if it
 * costs nothing.
 *
 * Two different bad outcomes, and they want different advice. Either the strip
 * has prose on it and the prose gets cut, which is fixable by taking the prose
 * off, and is exactly what the phone's own set is for. Or it has none, has
 * already given up every word it has, and is simply longer than the screen,
 * which nothing but removing an item can fix, so it says the number and says so.
 */
export function narrowWarning(narrow: { over: number; cut: string[] }): string | null {
  // Too long even with every word given up. Only reachable with no prose on the
  // strip to give way, so there is nothing to take off but a whole item.
  if (narrow.over > 0) {
    return `On a ${NARROWEST}px phone this is ${narrow.over}px too long even with every word given up, so a reading at the end would be cut off. Take an item off the phone's bar.`;
  }
  if (narrow.cut.length === 0) return null;
  return `On a ${NARROWEST}px phone this runs out of room, and ${joinWithAnd(narrow.cut)} will be cut short. Take ${narrow.cut.length > 1 ? "one of them" : "it"} off the phone's bar to keep every reading whole.`;
}

export interface BarEditor {
  editing: BarSet;
  setEditing: (set: BarSet) => void;
  rows: BarEditRow[];
  /** The phone set is unset, so the phone follows the desktop one. */
  inheriting: boolean;
  /** Whether the 320 px warning is about this set at all: see phoneShowsEditedSet. */
  shownOnPhone: boolean;
  used: ReadonlySet<BarRowId>;
  dragging: BarRowId | null;
  /** A row key, "end", or null for "releasing here places nothing". */
  caret: string | null;
  wasPlaceable: boolean;
  /** A chip is being dragged where letting go would remove it. */
  removing: boolean;
  barRef: RefObject<HTMLDivElement | null>;
  add: (id: BarRowId) => void;
  remove: (key: string) => void;
  useDefault: () => void;
  followDesktop: () => void;
  onDragStart: (e: DragStartEvent) => void;
  onDragMove: (e: DragMoveEvent) => void;
  onDragEnd: (e: DragEndEvent) => void;
  onDragCancel: () => void;
}

/** The provider's one Undo toast, shared by both tabs. */
export interface UndoChannel {
  /** Retires the toast on screen and returns this change's ticket. */
  retire: () => number;
  /** Offers an Undo for the change that took `ticket`; not if a newer change has retired it since. */
  offer: (said: string, undo: () => void, ticket: number) => void;
}

/** What an emptied strip is saved as: a gap, never nothing (an empty phone set means "follow the desktop"). */
const EMPTIED: BarEditRow = { key: "emptied", id: BAR_SPACER };

// Row keys, unique for the page's life. A counter, not crypto.randomUUID: that
// is undefined outside a secure context and production is plain HTTP.
let rowCounter = 0;
const nextRowKey = () => `row${++rowCounter}`;

const keyOfRows = (rows: readonly BarEditRow[]) => JSON.stringify(rows.map((r) => r.id));

/**
 * The bar's editor state.
 *
 * `opened` is "the mode is on", which is when the set being edited is chosen
 * (the device's own) and kept through any change of tab.
 *
 * Each set is a list the server holds whole, saved one change at a time (see
 * use-saved-list.ts), and the strip draws the list of the set being edited. An
 * edit is a function of the rows it lands on, so one made while another is
 * saving builds on that one, a refused one is dropped with the strip read back
 * from the server, and a save for one set never touches what the other shows.
 */
export function useBarEditor({
  opened,
  startOn,
  undo,
}: {
  opened: boolean;
  startOn: BarSet;
  undo: UndoChannel;
}): BarEditor {
  const queryClient = useQueryClient();
  const { state } = useStageState();
  const nextKey = nextRowKey;
  const barRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<BarRowId | null>(null);
  const [editing, setEditing] = useState<BarSet>(startOn);
  // Held as the RESOLVED target rather than a gap index so rendering never has
  // to read `still`, which is a ref.
  const [caret, setCaret] = useState<string | null>(null);
  // Whether the last pointer position was a place. Deliberately NOT cleared on
  // drop: the overlay reads its drop animation as it unmounts, after the caret
  // is gone. Reset at the start of the next drag.
  const [wasPlaceable, setWasPlaceable] = useState(false);
  /** The drag began on a chip in the bar, so letting go off the bar removes it. */
  const [fromChip, setFromChip] = useState(false);

  // The lists as broadcast. Memoised on what they say, so a broadcast about
  // something else mints no keys.
  const desktopKey = state ? JSON.stringify(visibleBarItems(state.barItems)) : null;
  const mobileKey = state ? JSON.stringify(hasMobileBar(state.barMobileItems) ? visibleBarItems(state.barMobileItems) : []) : null;
  const desktopSaved = useMemo(
    () => (desktopKey === null ? null : (JSON.parse(desktopKey) as BarRowId[]).map((id) => ({ key: nextKey(), id }))),
    [desktopKey, nextKey],
  );
  const mobileSaved = useMemo(
    () => (mobileKey === null ? null : (JSON.parse(mobileKey) as BarRowId[]).map((id) => ({ key: nextKey(), id }))),
    [mobileKey, nextKey],
  );
  const desktopIo = useMemo(() => barListIo(queryClient, "desktop", nextKey), [queryClient, nextKey]);
  const mobileIo = useMemo(() => barListIo(queryClient, "mobile", nextKey), [queryClient, nextKey]);
  // Not mid-drag, where the rows measured at the start must stay.
  const desktop = useSavedList({ io: desktopIo, saved: desktopSaved, keyOf: keyOfRows, hold: dragging !== null });
  const mobile = useSavedList({ io: mobileIo, saved: mobileSaved, keyOf: keyOfRows, hold: dragging !== null });
  // What a phone that follows the desktop bar forks from, read when the edit lands.
  const desktopRows = useLatestRef(desktop.list);

  // An unset phone set FOLLOWS the desktop one. So the phone set opens showing
  // the desktop arrangement, which is what the phone is showing, rather than an
  // empty strip that would read as "you have no bar on a phone".
  const inheriting = editing === "mobile" && mobile.list.length === 0;
  const rows = editing === "mobile" && !inheriting ? mobile.list : desktop.list;
  const shownOnPhone = phoneShowsEditedSet(editing, mobile.list.map((r) => r.id));

  // The set being edited is the device's own when the mode opens, and stays
  // whatever the operator then picks, across the Sidebar tab and back.
  useResyncOn([opened], () => {
    if (opened) setEditing(startOn);
  });

  // The rows in the strip at the start of a drag, the dragged one marked.
  // Safe to cache precisely because nothing shifts mid-drag.
  const still = useRef<MeasuredRow[]>([]);

  /**
   * Every change goes through here, so nothing reaches the server unnormalised
   * and the strip shows what was actually saved. It writes to the set being
   * edited, and ONLY that one: a change on the phone set while it still followed
   * the desktop bar is what forks it, so there is no separate "give the phone
   * its own set" step to forget. A newer change retires any Undo on screen.
   *
   * `make` is a function of the rows it lands on, and returns them unchanged for
   * "nothing to do". A refusal is said in the server's words, and the strip goes
   * back to what the server holds.
   *
   * Whether the phone is following is read when the edit lands, not when it was
   * clicked: an empty phone set is following, so it forks from the desktop rows
   * then. An edit queued behind a fork the server refused lands on a phone that is
   * following again, and must fork too, not build a set from nothing.
   */
  async function change(set: BarSet, make: (cur: BarEditRow[]) => BarEditRow[]): Promise<{ result: ListStepResult<BarEditRow>; ticket: number }> {
    const ticket = undo.retire();
    const result = await (set === "mobile" ? mobile : desktop).edit((l) => {
      const cur = set === "mobile" && l.length === 0 ? desktopRows.current : l;
      const next = make(cur);
      if (next === cur) return l;
      return next.length > 0 ? next : [EMPTIED];
    });
    if (!result.ok) toast.error(result.error);
    return { result, ticket };
  }

  /** Hand the phone back to the desktop bar. The one way out of a fork, and the
   *  reason forking on first edit is safe rather than a trap. */
  async function followDesktop(): Promise<void> {
    undo.retire();
    const result = await mobile.request(async () => barRowsOf(await saveBarSet(queryClient, "mobile", []), "mobile", nextKey));
    if (!result.ok) toast.error(result.error);
  }

  function add(id: BarRowId) {
    const row = { key: nextKey(), id };
    void change(editing, (cur) => [...cur, row]);
  }

  function remove(key: string) {
    void change(editing, (cur) => (cur.some((r) => r.key === key) ? cur.filter((r) => r.key !== key) : cur));
  }

  /**
   * The default set, with an Undo that puts back exactly what this set was when
   * the change landed: its own arrangement, or, for a phone that was following
   * the desktop bar (an empty set), the following. The Undo is offered once the
   * change has saved.
   */
  function useDefault() {
    const set = editing;
    const defaults = DEFAULT_BAR_ORDER.map((id) => ({ key: nextKey(), id }));
    void change(set, () => defaults).then(({ result, ticket }) => {
      if (!result.ok || !result.changed) return;
      const before = result.before.map((r) => r.id);
      undo.offer(
        "Restored the default bar.",
        () => {
          if (set === "mobile" && before.length === 0) void followDesktop();
          else {
            const restored = before.map((id) => ({ key: nextKey(), id }));
            void change(set, () => restored);
          }
        },
        ticket,
      );
    });
  }

  /** The gap this pointer position means, or null for "not a place". ONE
   *  function, used by both the caret and the drop, so the caret cannot promise
   *  a position the drop does not honour. */
  function gapFor(e: DragMoveEvent | DragEndEvent): number | null {
    if (!droppedOnBar(e, barRef.current?.getBoundingClientRect() ?? null)) return null;
    const p = dropPoint(e);
    return p ? gapFromBoxes(still.current, p) : null;
  }

  function onDragStart(e: DragStartEvent) {
    const data = e.active.data.current as BarDrag;
    const activeKey = data.kind === "bar-chip" ? data.key : null;
    // The dragged row is marked rather than left out: it is leaving its slot, so
    // it does not count for the gap, but its line still counts.
    still.current = [...(barRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [])].flatMap((n) => {
      const key = n.dataset.rowKey;
      if (!key) return [];
      const r = n.getBoundingClientRect();
      return [{ key, box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, dragged: key === activeKey }];
    });
    setWasPlaceable(false);
    setFromChip(data.kind === "bar-chip");
    setDragging(data.kind === "bar-tile" ? data.id : (rows.find((r) => r.key === data.key)?.id ?? null));
  }

  const stayingKeys = () => still.current.filter((r) => !r.dragged).map((r) => r.key);

  function onDragMove(e: DragMoveEvent) {
    const g = gapFor(e);
    setWasPlaceable(g !== null);
    setCaret(g === null ? null : (stayingKeys()[g] ?? "end"));
  }

  function onDragEnd(e: DragEndEvent) {
    const data = e.active.data.current as BarDrag;
    const g = gapFor(e);
    setDragging(null);
    setCaret(null);
    if (g === null) {
      // Not a place. A row dragged out of the bar goes; a tile flies home.
      if (data.kind === "bar-chip") remove(data.key);
      return;
    }
    const staying = stayingKeys();
    const tile = data.kind === "bar-tile" ? { key: nextKey(), id: data.id } : null;
    const drop = (cur: BarEditRow[]): BarEditRow[] => {
      const moved = tile ?? cur.find((r) => r.key === (data as { key: string }).key);
      if (!moved) return cur;
      const next = staying.flatMap((k) => cur.find((r) => r.key === k) ?? []);
      next.splice(g, 0, moved);
      // Let go where it was: nothing changed, nothing to save.
      return tile === null && sameBarIds(cur, next.map((r) => r.id)) ? cur : next;
    };
    if (drop(rows) === rows) return;
    void change(editing, drop);
  }

  function onDragCancel() {
    setDragging(null);
    setCaret(null);
    setWasPlaceable(false);
  }

  return {
    editing,
    setEditing,
    rows,
    inheriting,
    shownOnPhone,
    used: new Set(rows.map((r) => r.id)),
    dragging,
    caret,
    wasPlaceable,
    removing: dragging !== null && fromChip && !wasPlaceable,
    barRef,
    add: (id) => add(id),
    remove,
    useDefault,
    followDesktop: () => void followDesktop(),
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
  };
}

/**
 * The real context bar, editable in place: the strip the page shows, outlined,
 * with every reading a chip you can drag along it or out of it.
 */
export function BarEditStrip({ editor, ctx, isMobile }: { editor: BarEditor; ctx: BarItemContext; isMobile: boolean }) {
  const { barRef } = editor;
  const phoneOnDesktop = editor.editing === "mobile" && !isMobile;
  return (
    // The phone set on a wider screen is held to a phone's width, so an
    // arrangement that has to give up its words does it here, in front of the
    // person choosing it, rather than for the first time on a phone.
    <div className="relative mx-2.5 mt-2 shrink-0" style={phoneOnDesktop ? { maxWidth: PHONE_PREVIEW } : undefined}>
      {editor.editing === "mobile" && (
        <span className="absolute -top-2 left-2.5 z-[1] rounded bg-surface px-1.5 text-[10px] leading-[14px] tracking-[0.06em] text-accent uppercase">
          Phone bar
        </span>
      )}
      <div
        ref={barRef}
        // `bar-editor` WRAPS instead of fitting: see the rule in styles.css. No
        // fit ladder here, so every reading shows in full and can be read and
        // grabbed; the ladder's verdict for a phone is the 320 px warning.
        className={cn("bar-editor rounded-[10px] border border-dashed border-accent/70 bg-surface", BAR_STRIP_CLASS, "select-none")}
        aria-label={editor.editing === "mobile" ? "The phone's context bar" : "The context bar"}
      >
        {/* Gaps are not readings, so a strip carrying nothing else is still an
            empty bar and says so. Reachable on reopen: the arrangement saved for
            an emptied bar is ["spacer"]. */}
        {editor.rows.every((r) => isBarGap(r.id)) && !editor.dragging && (
          <span className="text-footnote text-fg-subtle italic">Drag something in.</span>
        )}
        {editor.rows.map((row) => (
          <Fragment key={row.key}>
            {editor.caret === row.key && <Caret along="row" />}
            <BarChip row={row} ctx={ctx} onRemove={() => editor.remove(row.key)} />
          </Fragment>
        ))}
        {editor.caret === "end" && <Caret along="row" />}
      </div>
    </div>
  );
}

/**
 * One reading in the bar being edited.
 *
 * The hover state is an absolutely-positioned pill BEHIND the content, not a
 * background on the row itself. A background on the row is the row's exact
 * bounds, which for a text reading is a rectangle hugging the glyphs and for a
 * stretched gap was a slab taller than everything beside it.
 */
function BarChip({ row, ctx, onRemove }: { row: BarEditRow; ctx: BarItemContext; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `bar-chip:${row.key}`,
    data: { kind: "bar-chip", key: row.key } satisfies BarDrag,
  });
  const label = presentation(row.id).label;
  const gap = isBarGap(row.id);

  return (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // Measured by key while a drag is running. The row does NOT move under the
      // pointer: the ghost is the feedback and the caret is the target, so what
      // you are aiming at stays where you saw it.
      data-row-key={row.key}
      className={cn(
        DRAGGABLE,
        "group relative flex items-center outline-none",
        // A gap has no content, so it needs a width of its own to be grabbable at
        // all. The flexible one grows, as the real one does. The fixed one is
        // shown at its true 24 px WITHOUT the negative margins it carries in the
        // bar: those exist so the width is the whitespace between two readings,
        // and in here they dragged the marker into the neighbouring gap.
        // A reading may shrink to the strip's width and no further (its prose
        // ellipsises): wider, it would push the strip into scrolling.
        row.id === BAR_SPACER ? "min-w-10 flex-1" : row.id === BAR_SPACE ? "w-6 shrink-0" : "min-w-0 max-w-full",
        isDragging && "opacity-35",
      )}
      aria-label={`${label}: drag to move`}
      title={`${label}: drag to move`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-y-1 -inset-x-0.5 rounded-md bg-fill opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
      <span aria-hidden="true" className="pointer-events-none absolute -inset-y-1 -inset-x-0.5 rounded-md ring-accent group-focus-visible:ring-2" />
      <span className={cn("relative flex h-5 w-full min-w-0 items-center", !gap && "gap-2.5")}>
        {gap ? (
          // Visible only in here. In the bar itself a gap is nothing at all.
          <span
            className={cn(
              "h-3.5 w-full rounded-[3px] border border-dashed border-line-strong",
              // Solid for the fixed one: the two have to be told apart at a
              // glance once both are in the bar.
              row.id === BAR_SPACE && "border-solid bg-fill",
            )}
          />
        ) : (
          // `preview: true`. In here a reading is a thing you drag, so an item that
          // is a real control in the bar renders as a plain reading: a live score
          // capsule would toggle its panel on the very press reaching for the row.
          //
          // NAME IT when it renders nothing. The score capsule is allowed to be
          // invisible in the bar (BarItem.canBeEmpty), and out of season it always
          // is; but a chip with no content has no width and no label, so the
          // operator could neither see the item they placed nor take hold of it.
          (renderBarItem(row.id as BarItemId, { ...ctx, preview: true }) ?? (
            <span className="truncate text-footnote text-fg-subtle italic">{label}</span>
          ))
        )}
      </span>
      <button
        type="button"
        // Drag-out is the gesture; this is the same act for a pointer that cannot
        // drag and for a keyboard, which has no drag at all.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className={cn(
          "touch-target absolute -right-2 -top-2 z-10 hidden size-4 items-center justify-center rounded-full",
          "border border-line-strong bg-surface text-fg-muted shadow-sm",
          "group-hover:flex group-focus-within:flex hover:border-danger-11 hover:text-danger-11",
          // Coarse pointer: always visible, not just on a hover it cannot
          // produce. `!` forces it over the bare `hidden` above: both are the
          // same specificity, and `coarse:` alone would leave the winner to
          // stylesheet source order.
          "coarse:flex!",
        )}
      >
        <XIcon className="size-2.5" />
      </button>
    </span>
  );
}

/**
 * The same arrangement, laid out off-screen at 320 px, so the tray can say what
 * will happen on the narrowest phone rather than only what is happening here.
 *
 * MEASURED, NOT PREDICTED. The alternative is a table of per-item widths kept in
 * sync by hand with the type scale, the icon set and whatever the plan happens to
 * be called this week: three things that move independently and one of which is
 * the operator's own data. This lays the real items out with the real strings
 * and reads the rung they land on.
 *
 * `aria-hidden`: it is a ruler, not a second bar. The reading it produces is
 * spoken by the warning instead.
 */
export function NarrowProbe({
  rows,
  ctx,
  onFit,
}: {
  rows: readonly BarRowId[];
  ctx: BarItemContext;
  onFit: (fit: { over: number; cut: string[] }) => void;
}) {
  const { ref, over } = useBarFit<HTMLDivElement>();

  // WHICH PROSE IS ACTUALLY CUT, read off the elements, not deduced from the
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
        // The reading itself, not the item's box: the box is what shrank, and the
        // reading is what got an ellipsis. A `plan` item with no plan loaded has
        // no prose element at all and cannot be cut.
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
        <BarStripRows rows={rows} ctx={ctx} preview />
      </div>
    </div>
  );
}
