// servicecue-drag.tsx — dragging on the ServiceCue layouts page.
//
// Four things move: layout cards (the landing page's order), a layout's role columns
// along its Columns row, a chip from "Not in this layout" into the row (or a role
// column out to it), and a role's categories (their priority). Each moves by pointer,
// by touch, and by keyboard (focus a grip, Space, the arrow keys, Space; Escape
// cancels), and every move is announced.
//
// The pointer half is dnd-kit's sensors, ghost and auto-scroll; where a drop lands is
// worked out here from the pointer and the rows' own rects (dropAt, below), because a
// wrapping row of chips is not a list dnd-kit's strategies can measure. The keyboard
// half moves by index, as the approved mockup does: the list is redrawn in its new
// order at each arrow, and saved once, on the drop.

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { GripVerticalIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/cn";
import type { FixedKey } from "./servicecue-layouts-model";

export type DragKind = "layout" | "col" | "tray" | "member";

/** What is being moved. `ctx` is the list it belongs to: a layout's id for a column or a
 *  tray chip, a role's id for a category, "" for the layouts. A tray chip's `id` is a
 *  role id, or `fixed:<key>` for Clock, Time and Max SPL. */
export interface DragItem {
  kind: DragKind;
  ctx: string;
  id: string;
  label: string;
  /** The role a category is moved within, by name, for its grip's label. */
  within?: string;
}

/** Where a pointer drop lands. `index` counts the list without the item being moved. */
export type DropTarget = { kind: "index"; index: number } | { kind: "remove" } | { kind: "fixed"; key: FixedKey };

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where in a wrapping row of chips a point lands: before the nearest chip, or after it.
 * "Nearest" weighs vertical distance a hundred times horizontal, so a point level with a
 * line of chips picks that line however far along it is: past the end of the second
 * line is the end of the row, not the end of the first line above it.
 */
export function insertIndex(rects: readonly Rect[], x: number, y: number): number {
  if (rects.length === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  rects.forEach((r, i) => {
    const cx = Math.max(r.left, Math.min(x, r.right));
    const cy = Math.max(r.top, Math.min(y, r.bottom));
    const d = (x - cx) ** 2 + 100 * (y - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const r = rects[best];
  return x < r.left + (r.right - r.left) / 2 ? best : best + 1;
}

/** Where in a column of cards a point lands: before the first card whose middle is below it. */
export function stackIndex(rects: readonly Rect[], y: number): number {
  const i = rects.findIndex((r) => y < r.top + (r.bottom - r.top) / 2);
  return i < 0 ? rects.length : i;
}

/** The element whose `attr` is `value`. Compared, not put in a selector: a role's
 *  categories are the operator's own words, quotes and all. */
export const byData = (attr: string, value: string): Element | null =>
  [...document.querySelectorAll(`[${attr}]`)].find((el) => el.getAttribute(attr) === value) ?? null;

const within = (r: Rect, x: number, y: number, pad: number) =>
  x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

type Marker = { x: number; y: number; w: number; h: number } | null;

/** The rects of the elements carrying `attr` under `root`, the item being moved (`attr` = `skip`) left out. */
function rectsOf(root: Element, attr: string, skip: string | null): { el: Element; r: Rect }[] {
  return [...root.querySelectorAll(`[${attr}]`)]
    .filter((el) => el.getAttribute(attr) !== skip)
    .map((el) => ({ el, r: el.getBoundingClientRect() }));
}

const before = (r: Rect): Marker => ({ x: r.left - 4.5, y: r.top, w: 3, h: r.bottom - r.top });
const after = (r: Rect): Marker => ({ x: r.right + 1.5, y: r.top, w: 3, h: r.bottom - r.top });

/**
 * The drop a point makes for `item`, and where to draw the marker for it, read from the
 * page as it is laid out now. Null when the point is outside every list the item can go to.
 */
function dropAt(item: DragItem, x: number, y: number): { target: DropTarget | null; marker: Marker; trayOn: boolean } {
  const none = { target: null, marker: null, trayOn: false };
  if (item.kind === "layout") {
    const list = document.querySelector('[data-sort-list="layouts"]');
    if (!list || !within(list.getBoundingClientRect(), x, y, 48)) return none;
    const cards = rectsOf(list, "data-layout-card", item.id);
    if (cards.length === 0) return none;
    const index = stackIndex(cards.map((c) => c.r), y);
    const lr = list.getBoundingClientRect();
    const lineY = index < cards.length ? cards[index].r.top - 6.5 : cards[cards.length - 1].r.bottom + 3.5;
    return { target: { kind: "index", index }, marker: { x: lr.left, y: lineY, w: lr.right - lr.left, h: 3 }, trayOn: false };
  }
  if (item.kind === "member") {
    const row = byData("data-members", item.ctx);
    if (!row || !within(row.getBoundingClientRect(), x, y, 16)) return none;
    const chips = rectsOf(row, "data-sort-id", item.id);
    const index = insertIndex(chips.map((c) => c.r), x, y);
    const add = row.querySelector("[data-add-member]");
    const marker = chips.length === 0 ? (add ? before(add.getBoundingClientRect()) : null) : index < chips.length ? before(chips[index].r) : after(chips[chips.length - 1].r);
    return { target: { kind: "index", index }, marker, trayOn: false };
  }
  // A column or a tray chip: the layout's Columns row, or its tray.
  const row = byData("data-cols", item.ctx);
  const tray = byData("data-tray", item.ctx);
  if (item.kind === "col" && tray && within(tray.getBoundingClientRect(), x, y, 6)) {
    return { target: { kind: "remove" }, marker: null, trayOn: true };
  }
  if (!row || !within(row.getBoundingClientRect(), x, y, 22)) return none;
  if (item.id.startsWith("fixed:")) {
    // Clock, Time and Max SPL have a place of their own: the marker shows it, wherever
    // in the row the chip is let go.
    const key = item.id.slice(6) as FixedKey;
    const anchor = row.querySelector('[data-anchor="item"]');
    if (!anchor) return none;
    let marker: Marker;
    if (key === "showClock") marker = before((row.querySelector('[data-fixed="showLength"]') ?? anchor).getBoundingClientRect());
    else if (key === "showLength") marker = before(anchor.getBoundingClientRect());
    else marker = after((row.lastElementChild ?? anchor).getBoundingClientRect());
    return { target: { kind: "fixed", key }, marker, trayOn: false };
  }
  const chips = rectsOf(row, "data-sort-id", item.kind === "col" ? item.id : null);
  const index = insertIndex(chips.map((c) => c.r), x, y);
  const anchor = row.querySelector('[data-anchor="item"]');
  const marker = chips.length === 0 ? (anchor ? after(anchor.getBoundingClientRect()) : null) : index < chips.length ? before(chips[index].r) : after(chips[chips.length - 1].r);
  return { target: { kind: "index", index }, marker, trayOn: false };
}

// ── announcements ──────────────────────────────────────────────────────────

/**
 * A live region and the function that speaks into it: what moved, what was added,
 * what was deleted. Emptied before each message, so the same words said twice are
 * still read twice.
 */
export function useAnnouncer(): { announce: (message: string) => void; region: ReactNode } {
  const live = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = useCallback((message: string) => {
    const el = live.current;
    if (!el) return;
    el.textContent = "";
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      el.textContent = message;
    }, 30);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return { announce, region: <div ref={live} aria-live="polite" aria-atomic="true" className="sr-only" data-announcer /> };
}

// ── the page's one drag context ─────────────────────────────────────────────

interface Lifted {
  kind: DragKind;
  ctx: string;
  id: string;
  label: string;
  /** The order when it was picked up, put back by Escape. */
  snap: string[];
  /** The order as the arrows have moved it. */
  order: string[];
}

interface DragState {
  /** The item a pointer is carrying. */
  active: DragItem | null;
  /** A list's order while the keyboard is moving one of its items, else null. */
  liftedOrder: (kind: DragKind, ctx: string) => string[] | null;
  isLifted: (kind: DragKind, ctx: string, id: string) => boolean;
  /** The grip's keys: Space or Enter picks up and drops, arrows move, Escape cancels. */
  onGripKey: (e: KeyboardEvent, item: DragItem, order: readonly string[]) => void;
  /** True while a pointer carrying a column is over this layout's tray. */
  trayOn: (ctx: string) => boolean;
  /** The click that ends a drag of this tray chip is not a click on it. */
  swallowClick: (id: string) => boolean;
}

const DragContext = createContext<DragState | null>(null);

function useDrag(): DragState {
  const d = useContext(DragContext);
  if (!d) throw new Error("useDrag outside LayoutsDnd");
  return d;
}

/** The drag handlers' answers: what a pointer drop and a keyboard drop save. */
export interface DropHandlers {
  /** A pointer let go over a list. Returns what to announce. */
  onDrop: (item: DragItem, target: DropTarget) => string;
  /** The keyboard dropped an item: its list in the new order. */
  onReorder: (item: DragItem, order: string[]) => void;
}

const dragKey = (item: Pick<DragItem, "kind" | "ctx" | "id">) => `${item.kind}\u0000${item.ctx}\u0000${item.id}`;

export function LayoutsDnd({
  handlers,
  announce,
  children,
}: {
  handlers: DropHandlers;
  announce: (message: string) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    // Mouse and touch apart, as on Mic slots. Every grip and tray chip is
    // `touch-action: none`, so a touch on one is a drag and never a scroll, and five
    // pixels is enough to tell it from a tap.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 5 } }),
  );

  const [active, setActive] = useState<DragItem | null>(null);
  const [trayCtx, setTrayCtx] = useState<string | null>(null);
  const target = useRef<DropTarget | null>(null);
  const marker = useRef<HTMLDivElement>(null);
  // Where the pointer is, in the viewport, as the drop rects are. Not dnd-kit's
  // start-plus-delta: its delta also counts how far the page scrolled since the
  // drag began, which no rect read now has moved by.
  const pointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const carrying = useRef<DragItem | null>(null);
  const stopTracking = useRef<(() => void) | null>(null);
  const swallow = useRef<string | null>(null);
  useEffect(() => () => stopTracking.current?.(), []);
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
  });

  const drawMarker = (m: Marker) => {
    const el = marker.current;
    if (!el) return;
    if (!m) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    Object.assign(el.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
  };

  function onDragStart(e: DragStartEvent) {
    const item = e.active.data.current as DragItem | undefined;
    if (!item) return;
    const ev = e.activatorEvent as MouseEvent | TouchEvent;
    const p = "touches" in ev ? ev.touches[0] : ev;
    pointer.current = { x: p?.clientX ?? 0, y: p?.clientY ?? 0 };
    target.current = null;
    carrying.current = item;
    setActive(item);
    // The pointer is read as it moves, and the landing point worked out again when
    // anything scrolls under a pointer that has not moved.
    const onMove = (m: MouseEvent | PointerEvent | TouchEvent) => {
      const at = "touches" in m ? m.touches[0] : m;
      if (at) pointer.current = { x: at.clientX, y: at.clientY };
    };
    const onScroll = () => relocate();
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("mousemove", onMove, opts);
    window.addEventListener("touchmove", onMove, opts);
    window.addEventListener("scroll", onScroll, opts);
    stopTracking.current = () => {
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("mousemove", onMove, opts);
      window.removeEventListener("touchmove", onMove, opts);
      window.removeEventListener("scroll", onScroll, opts);
    };
    // The pointer let go over a tray chip it picked up must not also add it. The
    // click that follows the release is swallowed, and only that one: cleared once
    // the release has been dispatched.
    if (item.kind === "tray") {
      swallow.current = item.id;
      const clear = () => setTimeout(() => {
        swallow.current = null;
      }, 0);
      window.addEventListener("pointerup", clear, { once: true, capture: true });
    }
    announce(`Picked up ${item.label}.`);
  }

  /** Where the carried item would land at the pointer, and the marker for it. */
  function relocate() {
    const item = carrying.current;
    if (!item) return;
    const at = dropAt(item, pointer.current.x, pointer.current.y);
    target.current = at.target;
    drawMarker(at.marker);
    setTrayCtx(at.trayOn ? item.ctx : null);
  }

  function onDragMove() {
    relocate();
  }

  function finish() {
    stopTracking.current?.();
    stopTracking.current = null;
    carrying.current = null;
    setActive(null);
    setTrayCtx(null);
    drawMarker(null);
    target.current = null;
  }

  function onDragEnd(e: DragEndEvent) {
    const item = e.active.data.current as DragItem | undefined;
    const t = target.current;
    finish();
    if (!item) return;
    announce(t ? handlersRef.current.onDrop(item, t) : `${item.label} dropped outside the list. Nothing changed.`);
  }

  function onDragCancel() {
    finish();
    announce("Move cancelled. Nothing changed.");
  }

  // ── keyboard ──
  const [lifted, setLifted] = useState<Lifted | null>(null);
  const liftedRef = useRef<Lifted | null>(null);
  useLayoutEffect(() => {
    liftedRef.current = lifted;
  });

  const drop = useCallback(() => {
    const l = liftedRef.current;
    if (!l) return;
    setLifted(null);
    if (l.order.join("\u0000") !== l.snap.join("\u0000")) {
      handlersRef.current.onReorder({ kind: l.kind, ctx: l.ctx, id: l.id, label: l.label }, l.order);
    }
    announce(`Dropped ${l.label} at position ${l.order.indexOf(l.id) + 1} of ${l.order.length}.`);
  }, [announce]);

  // A lifted item is dropped where it is when the operator clicks anywhere else.
  useEffect(() => {
    if (!lifted) return;
    const key = dragKey(lifted);
    const onDown = (e: PointerEvent) => {
      const grip = (e.target as Element | null)?.closest?.("[data-grip]");
      if (grip?.getAttribute("data-grip") !== key) drop();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [lifted, drop]);

  const onGripKey = useCallback((e: KeyboardEvent, item: DragItem, order: readonly string[]) => {
    const l = liftedRef.current;
    const k = e.key;
    if (!l || dragKey(l) !== dragKey(item)) {
      if (k !== " " && k !== "Enter") return;
      e.preventDefault();
      const snap = [...order];
      setLifted({ ...item, snap, order: snap });
      announce(`Picked up ${item.label}, position ${snap.indexOf(item.id) + 1} of ${snap.length}. Arrow keys move it, Space drops it, Escape cancels.`);
      return;
    }
    if (k === " " || k === "Enter" || k === "Tab") {
      e.preventDefault();
      drop();
    } else if (k === "Escape") {
      e.preventDefault();
      setLifted(null);
      announce(`Move cancelled. ${l.label} is back at position ${l.snap.indexOf(l.id) + 1} of ${l.snap.length}.`);
    } else if (k === "ArrowLeft" || k === "ArrowUp" || k === "ArrowRight" || k === "ArrowDown") {
      e.preventDefault();
      const d = k === "ArrowLeft" || k === "ArrowUp" ? -1 : 1;
      const i = l.order.indexOf(l.id);
      const j = i + d;
      if (j < 0 || j >= l.order.length) {
        announce(`${l.label} is already ${d < 0 ? "first" : "last"}.`);
        return;
      }
      const next = [...l.order];
      [next[i], next[j]] = [next[j], next[i]];
      setLifted({ ...l, order: next });
      announce(`${l.label}, position ${j + 1} of ${next.length}.`);
    }
  }, [announce, drop]);

  const state = useMemo<DragState>(() => ({
    active,
    liftedOrder: (kind, ctx) => (lifted && lifted.kind === kind && lifted.ctx === ctx ? lifted.order : null),
    isLifted: (kind, ctx, id) => !!lifted && lifted.kind === kind && lifted.ctx === ctx && lifted.id === id,
    onGripKey,
    trayOn: (ctx) => trayCtx === ctx,
    swallowClick: (id) => swallow.current === id,
  }), [active, lifted, onGripKey, trayCtx]);

  return (
    <DragContext.Provider value={state}>
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
          // The page says what moved, in its own words, on the live region below.
          accessibility={{ announcements: QUIET, screenReaderInstructions: { draggable: "" } }}
        >
          <div className={cn(active && "cursor-grabbing select-none [&_*]:cursor-grabbing")}>{children}</div>
          <DragOverlay dropAnimation={null}>
            {active && (
              <div
                className={cn(
                  "pointer-events-none whitespace-nowrap border border-line-strong bg-popover text-footnote font-medium text-fg opacity-95 shadow-[var(--su-shadow-2)]",
                  active.kind === "layout" ? "rounded-xl px-4 py-3 text-[14px] font-semibold" : "inline-flex h-[30px] items-center rounded-md px-2.5",
                )}
                data-drag-ghost
              >
                {active.label}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      <div ref={marker} hidden aria-hidden="true" data-drop-marker className="pointer-events-none fixed z-[59] rounded-sm bg-accent shadow-[0_0_0_2px_var(--su-accent-soft)]" />
    </DragContext.Provider>
  );
}

const QUIET = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

/** A list's order while the keyboard is moving one of its items; null otherwise. */
export function useLiftedOrder(kind: DragKind, ctx: string): string[] | null {
  return useDrag().liftedOrder(kind, ctx);
}

/** `items` in the order the keyboard has moved them to, while one of them is picked up. */
export function LiftedList<T extends { id: string }>({
  kind,
  ctx,
  items,
  children,
}: {
  kind: DragKind;
  ctx: string;
  items: readonly T[];
  children: (item: T) => ReactNode;
}) {
  const order = useLiftedOrder(kind, ctx);
  const byId = new Map(items.map((i) => [i.id, i]));
  const shown = order ? order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) : items;
  return <>{shown.map(children)}</>;
}

/** What a grip moves, said so that two grips on the page never share a name: a layout
 *  and a role column are often both called Audio. */
function gripName(item: DragItem): string {
  if (item.kind === "layout") return `the ${item.label} layout`;
  if (item.kind === "col") return `the ${item.label} column`;
  return item.kind === "member" && item.within ? `${item.label} in ${item.within}` : item.label;
}

/** The handle an item is moved by: dragged with a pointer, or picked up with Space. */
export function Grip({ item, order, size = "md" }: { item: DragItem; order: readonly string[]; size?: "md" | "sm" }) {
  const drag = useDrag();
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: dragKey(item), data: item });
  const lifted = drag.isLifted(item.kind, item.ctx, item.id);
  const ref = useRef<HTMLButtonElement | null>(null);
  // The item is redrawn at each arrow; focus stays on its grip.
  useLayoutEffect(() => {
    if (lifted && document.activeElement !== ref.current) ref.current?.focus();
  });
  return (
    <button
      type="button"
      ref={(el) => {
        ref.current = el;
        setNodeRef(el);
      }}
      {...listeners}
      onKeyDown={(e) => drag.onGripKey(e, item, order)}
      data-grip={dragKey(item)}
      data-dragging={isDragging || undefined}
      aria-roledescription="sortable"
      aria-pressed={lifted}
      aria-label={`Move ${gripName(item)}. Press Space to pick up`}
      className={cn(
        "inline-grid shrink-0 cursor-grab touch-none place-items-center rounded-[5px] p-0 text-fg-subtle transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        "aria-pressed:bg-accent-soft aria-pressed:text-accent",
        size === "sm" ? "h-6 w-5" : "h-[30px] w-6",
      )}
    >
      <GripVerticalIcon className="size-3.5" aria-hidden="true" />
    </button>
  );
}

/** Is this item being carried by a pointer (drawn faded where it was)? */
export function useCarried(item: Pick<DragItem, "kind" | "ctx" | "id">): boolean {
  const { active } = useDrag();
  return !!active && dragKey(active) === dragKey(item);
}

/** Is this item picked up by the keyboard (drawn lifted)? */
export function useLifted(item: Pick<DragItem, "kind" | "ctx" | "id">): boolean {
  return useDrag().isLifted(item.kind, item.ctx, item.id);
}

/** Is a column being carried over this layout's tray? */
export function useTrayOn(ctx: string): boolean {
  return useDrag().trayOn(ctx);
}

/** A chip in "Not in this layout": click it to add, or drag it to a spot in the row. */
export function TrayChip({ item, title, onAdd, children }: { item: DragItem; title?: string; onAdd: () => void; children: ReactNode }) {
  const drag = useDrag();
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: dragKey(item), data: item });
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      onClick={() => {
        if (!drag.swallowClick(item.id)) onAdd();
      }}
      title={title}
      aria-label={`Add ${item.label}`}
      data-focus-key={`tray:${item.ctx}:${item.id}`}
      className={cn(
        "inline-flex h-[30px] cursor-grab touch-none select-none items-center gap-1 whitespace-nowrap rounded-md border border-dashed border-line-strong bg-transparent pl-[7px] pr-2.5 text-footnote text-fg-muted transition-colors hover:border-accent hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        isDragging && "opacity-35",
      )}
    >
      {children}
    </button>
  );
}
