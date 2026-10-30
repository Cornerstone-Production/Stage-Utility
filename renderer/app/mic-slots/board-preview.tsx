// A board's preview: the kiosk's own SlotsColumns, with drop zones and handles
// drawn over it through its editing layer.
//
// Everything here is a droppable or a draggable of the PAGE's one DndContext
// (mic-slots-page.tsx), so a card can be dropped on any board. The zones add no
// width: a gap is a zero-width flex item whose hit area is an absolutely
// positioned strip over the boundary, so the columns sit exactly where the
// screen puts them.
//
// Not unit-tested, and driven in a browser instead: the drop-zone geometry and
// its pointer hit-testing. jsdom lays nothing out, so every rect is empty there.
// The moves themselves are board-model.ts, tested as functions, and the keyboard
// path is tested through the rendered card.

import { useDraggable, useDndContext, useDroppable } from "@dnd-kit/core";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { SlotsColumns, groupColumns, isSpacerColumn, type SlotsColumnsEditing } from "../../components/slots-columns";
import { cn } from "../../lib/cn";
import type { Drag, Drop, Nudge } from "./board-model";

/** What a draggable carries, so a drop zone can tell whether it may take it. */
export interface DragData {
  drag: Drag;
  /** Every slot id the drag moves: a card's own, or its whole column's. */
  slotIds: string[];
  spacer: boolean;
  /** What the ghost under the pointer says. */
  label: string;
}

export interface DropData {
  drop: Drop;
}

/**
 * The card a key press moved, which must hold focus afterwards.
 *
 * A card moved into another column is a new element (its parent changed), so the
 * browser drops focus to the page and the next key press goes nowhere. Whoever
 * moves a card by keyboard names it here; the card that mounts under that id takes
 * focus back, once.
 */
let refocus: string | null = null;

const KEY_DIRECTION: Record<string, Nudge> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** Wide enough to hit, narrow enough not to take a card's edge. */
const GAP_ZONE_PX = 18;

/** The name a card goes by in the editor. */
export function slotTitle(slot: Slot): string {
  if (slot.displayName) return slot.displayName;
  if (slot.link.kind === "static") return slot.link.label || "Label";
  if (slot.link.kind === "empty") return "Empty";
  if (slot.link.kind === "pco" && slot.link.matchBy === "position") {
    const names = slot.link.positions.map((p) => p.name ?? "Any");
    return names.length > 0 ? names.join(" / ") : "No position yet";
  }
  return "Person";
}

function useDragging() {
  const { active } = useDndContext();
  return { active, data: (active?.data.current ?? null) as DragData | null };
}

function Gap({ boardId, index }: { boardId: string; index: number }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `gap:${boardId}:${index}`,
    data: { drop: { kind: "gap", boardId, index } } satisfies DropData,
  });
  const { active } = useDragging();
  return (
    <div className="relative z-20 w-0 shrink-0 self-stretch">
      <div
        ref={setNodeRef}
        data-mic-gap={`${boardId}:${index}`}
        className={cn("absolute inset-y-0 left-0 flex -translate-x-1/2 justify-center", !active && "pointer-events-none")}
        style={{ width: GAP_ZONE_PX }}
      >
        <span
          className={cn(
            "w-[3px] rounded-full transition-colors",
            isOver ? "bg-accent" : active ? "bg-accent/25" : "bg-transparent",
          )}
        />
      </div>
    </div>
  );
}

function StackZone({ slot }: { slot: Slot }) {
  const { active, data } = useDragging();
  // A spacer never stacks, and nothing stacks onto itself or its own column.
  const refused = !!data && (data.spacer || data.slotIds.includes(slot.id));
  const { setNodeRef, isOver } = useDroppable({
    id: `stack:${slot.id}`,
    data: { drop: { kind: "stack", targetId: slot.id } } satisfies DropData,
    disabled: refused,
  });
  const shown = !!active && !refused;
  // The zone lies over the card's name band. Only the zone under the pointer
  // says anything, and it is opaque so it covers the band rather than printing
  // over the name; every other zone is an edge and a faint tint, no text.
  return (
    <div
      ref={setNodeRef}
      data-mic-stack={slot.id}
      className={cn(
        "pointer-events-none absolute inset-x-1.5 bottom-1.5 z-20 flex h-[45%] items-center justify-center rounded-b-xl transition-opacity",
        shown ? "opacity-100" : "opacity-0",
        isOver ? "border-t-2 border-accent" : "border-t border-dashed border-accent/45 bg-accent/10",
      )}
      style={isOver ? { background: "color-mix(in srgb, var(--color-accent) 30%, #111111)" } : undefined}
    >
      {isOver && (
        <span data-mic-stack-label className="px-1 text-center text-caption2 font-semibold uppercase leading-tight tracking-wider text-white">
          Stack below
        </span>
      )}
    </div>
  );
}

/**
 * An empty board's whole frame, as its one gap: a card dropped anywhere on it
 * becomes the board's first column. Without it an empty board has no zones, and
 * the first card could only reach it by a button.
 */
export function EmptyBoardDrop({ boardId, children }: { boardId: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `gap:${boardId}:0`,
    data: { drop: { kind: "gap", boardId, index: 0 } } satisfies DropData,
  });
  const { active } = useDragging();
  return (
    <div
      ref={setNodeRef}
      data-mic-gap={`${boardId}:0`}
      className={cn("h-full rounded-md border-2 border-transparent", active && "border-dashed border-accent/40", isOver && "border-solid border-accent bg-accent/10")}
    >
      {children}
    </div>
  );
}

/** What the page can do to a card from the keyboard or its handles. */
export interface BoardPreviewActions {
  select: (slotId: string) => void;
  nudge: (slotId: string, dir: Nudge) => void;
  stack: (slotId: string) => void;
  unstack: (slotId: string) => void;
  remove: (slotId: string) => void;
}

function Card({
  slot,
  selected,
  highlighted,
  actions,
  children,
}: {
  slot: Slot;
  selected: boolean;
  /** Named by the plan check: needs a look. */
  highlighted: boolean;
  actions: BoardPreviewActions;
  children: ReactNode;
}) {
  const data: DragData = { drag: { kind: "slot", id: slot.id }, slotIds: [slot.id], spacer: false, label: slotTitle(slot) };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `card:${slot.id}`, data });
  const { active } = useDragging();
  const node = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (refocus === slot.id) {
      refocus = null;
      node.current?.focus();
    }
  }, [slot.id]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // While dnd-kit's keyboard drag is running it owns the arrow keys.
    if (!active) {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        actions.remove(slot.id);
        return;
      }
      const dir = KEY_DIRECTION[e.key];
      if (dir) {
        e.preventDefault();
        refocus = slot.id;
        // Shift+Down stacks onto the column to the left; Shift+Up takes a card
        // out of its stack. Plain arrows move.
        if (e.shiftKey && dir === "down") actions.stack(slot.id);
        else if (e.shiftKey && dir === "up") actions.unstack(slot.id);
        else if (!e.shiftKey) actions.nudge(slot.id, dir);
        return;
      }
    }
    listeners?.onKeyDown?.(e);
  }

  return (
    <div
      ref={(el) => {
        node.current = el;
        setNodeRef(el);
      }}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      onClick={() => actions.select(slot.id)}
      onFocus={() => actions.select(slot.id)}
      aria-label={`Slot ${slot.channel ? `${slot.channel} ` : ""}${slotTitle(slot)}`}
      aria-pressed={selected}
      data-mic-slot={slot.id}
      data-selected={selected ? "true" : undefined}
      data-highlighted={highlighted ? "true" : undefined}
      className={cn("relative flex min-h-0 flex-1 cursor-grab flex-col outline-none", isDragging && "opacity-35")}
    >
      {children}
      {highlighted && !selected && <span className="pointer-events-none absolute inset-1.5 z-10 rounded-xl ring-2 ring-warn-9" />}
      {selected && <span className="pointer-events-none absolute inset-1.5 z-10 rounded-xl ring-2 ring-accent" />}
      <StackZone slot={slot} />
    </div>
  );
}

/** The bar over a column: drags the whole stack. */
function ColumnBar({ column }: { column: Slot[] }) {
  const lead = column[0]!;
  const data: DragData = {
    drag: { kind: "column", id: lead.id },
    slotIds: column.map((s) => s.id),
    spacer: false,
    label: column.length > 1 ? `${slotTitle(lead)} and ${column.length - 1} more` : slotTitle(lead),
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `col:${lead.id}`, data });
  const { active } = useDragging();
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      title="Drag the whole column"
      aria-label={`Drag the column of ${slotTitle(lead)}`}
      data-mic-column-bar={lead.id}
      className={cn(
        "mx-1.5 mt-1.5 flex h-3 shrink-0 cursor-grab items-center justify-center rounded",
        active ? "bg-transparent" : "bg-white/5",
        isDragging && "opacity-35",
      )}
    >
      <span className="h-[3px] w-6 rounded-full bg-white/30" />
    </div>
  );
}

function SpacerBlock({
  column,
  selected,
  aligned,
  actions,
}: {
  column: Slot[];
  selected: boolean;
  aligned: boolean;
  actions: BoardPreviewActions;
}) {
  const lead = column[0]!;
  const data: DragData = { drag: { kind: "column", id: lead.id }, slotIds: column.map((s) => s.id), spacer: true, label: "Spacer" };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `col:${lead.id}`, data });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => actions.select(lead.id)}
      onFocus={() => actions.select(lead.id)}
      onKeyDown={(e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          actions.remove(lead.id);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          actions.nudge(lead.id, e.key === "ArrowLeft" ? "left" : "right");
        } else listeners?.onKeyDown?.(e);
      }}
      aria-label={`Spacer${aligned && lead.widthIn ? ` ${lead.widthIn} inches` : ""}`}
      aria-pressed={selected}
      data-mic-spacer={lead.id}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "m-1.5 flex flex-1 cursor-grab items-end justify-center rounded-xl border pb-2 outline-none",
        "bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.05)_0_6px,transparent_6px_12px)]",
        selected ? "border-accent" : "border-dashed border-white/20",
        isDragging && "opacity-35",
      )}
    >
      <span className="font-mono text-caption2 text-white/60">{aligned && lead.widthIn ? `${lead.widthIn} in` : "spacer"}</span>
    </div>
  );
}

/** Where the charger banks sit, as percentages of the display's width: each run
 *  of columns between spacers. Empty when the board is not aligned. */
export function chargerBanks(slots: readonly Slot[], layout: SlotsLayout | null): { startPct: number; endPct: number; columns: number }[] {
  if (!layout || layout.displayWidthIn <= 0) return [];
  const columns = groupColumns(slots);
  const widths = columns.map((c) => ((c[0]?.widthIn ?? layout.columnWidthIn) / layout.displayWidthIn) * 100);
  const total = widths.reduce((a, b) => a + b, 0);
  let x = Math.max(0, (100 - total) / 2);
  const banks: { startPct: number; endPct: number; columns: number }[] = [];
  let open: { startPct: number; endPct: number; columns: number } | null = null;
  columns.forEach((c, i) => {
    if (isSpacerColumn(c)) {
      open = null;
    } else {
      if (!open) {
        open = { startPct: x, endPct: x, columns: 0 };
        banks.push(open);
      }
      open.endPct = x + widths[i]!;
      open.columns += 1;
    }
    x += widths[i]!;
  });
  return banks;
}

export function BoardPreview({
  boardId,
  slots,
  layout,
  selectedId,
  highlighted,
  actions,
  emptySlotLogo,
  defaultAvatar,
}: {
  boardId: string;
  /** The draft, with who and what is live laid over it. */
  slots: Slot[];
  layout: SlotsLayout | null;
  selectedId: string | null;
  highlighted: ReadonlySet<string>;
  actions: BoardPreviewActions;
  emptySlotLogo: string | null;
  defaultAvatar: string | null;
}) {
  const editing: SlotsColumnsEditing = {
    gap: (index) => <Gap key={`gap-${index}`} boardId={boardId} index={index} />,
    column: (column, _i, cards) => (
      <>
        <ColumnBar column={column} />
        {cards}
      </>
    ),
    card: (slot, panel) => (
      <Card slot={slot} selected={selectedId === slot.id} highlighted={highlighted.has(slot.id)} actions={actions}>
        {panel}
      </Card>
    ),
    spacer: (column) => (
      <SpacerBlock column={column} selected={column.some((s) => s.id === selectedId)} aligned={!!layout} actions={actions} />
    ),
  };
  return (
    <SlotsColumns
      slots={slots}
      slotsLayout={layout}
      emptySlotLogo={emptySlotLogo}
      defaultAvatar={defaultAvatar}
      className="h-full w-full"
      editing={editing}
    />
  );
}
