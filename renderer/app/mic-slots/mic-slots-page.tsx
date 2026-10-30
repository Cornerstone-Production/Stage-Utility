// /mic-slots — every mic slot board on one page.
//
// A board is a named set of slot layouts that slots screens and slots widgets
// show. This page edits all of them at once: one section per board with a
// screen-shaped preview drawn by the kiosk's own components, a plan switcher
// over the lot, and an inspector for the selected slot. Dragging works across
// boards because the whole page is ONE DndContext.
//
// Nothing here reaches a screen until Save all. See use-mic-slots.ts.

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useBlocker } from "@tanstack/react-router";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, EmptyState, ErrorNote, confirm } from "../../components/ui";
import { useSearchParam, useRouterHandle } from "../../lib/use-search-param";
import { errorMessage } from "@main/services/errors";
import { plural } from "@main/services/plural";
import { useSlotPresets, useWirelessChannels } from "../queries";
import { applyDrop, itemsOf, isSpacer, stackState } from "./board-model";
import { ChargerLayoutDialog, CopyFromDialog, DeleteBoardDialog, NewBoardDialog } from "./board-dialogs";
import { BoardSection, type BoardDialogs } from "./board-section";
import type { DragData, DropData } from "./board-preview";
import { PlanCheck } from "./plan-check";
import { SlotInspector, SpacerInspector } from "./slot-inspector";
import { makeSharesWith } from "./shares-with";
import { TopBar } from "./top-bar";
import { displayWidthOf, showTargets, useMicSlots, type ShowTarget } from "./use-mic-slots";

/** The slot zones win over a card's own, and a pointer picks by where it is; a
 *  keyboard drag has no pointer, so it goes by the nearest zone. */
const collide: CollisionDetection = (args) => {
  if (args.pointerCoordinates) {
    const hits = pointerWithin(args);
    // A gap is a narrow strip laid over a card's edge: where they overlap the
    // gap is the one meant.
    const gaps = hits.filter((h) => String(h.id).startsWith("gap:"));
    return gaps.length > 0 ? gaps : hits;
  }
  return closestCenter(args);
};

/** Leaving the page with unsaved work asks first, for a link, Back and a closing
 *  tab alike. Rendered only under a router: useBlocker needs one. */
export function LeaveGuard({ dirty, count }: { dirty: boolean; count: number }) {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  const asked = useRef(false);
  useEffect(() => {
    if (blocker.status !== "blocked" || asked.current) return;
    asked.current = true;
    void confirm({
      title: "Leave without saving?",
      message: `${plural(count, "board")} ${count === 1 ? "has" : "have"} changes that are not saved. Leaving loses them.`,
      confirmLabel: "Leave",
      destructive: true,
    }).then((ok) => {
      asked.current = false;
      if (ok) blocker.proceed?.();
      else blocker.reset?.();
    });
  }, [blocker, count]);
  return null;
}

export function MicSlotsPage() {
  const mic = useMicSlots();
  const { data: presets = [] } = useSlotPresets();
  const { data: wirelessChannels = [] } = useWirelessChannels();
  const router = useRouterHandle();
  const [linked, setLinked] = useSearchParam("board");

  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<SlotBoardDTO | null>(null);
  const [chargers, setChargers] = useState<SlotBoardDTO | null>(null);
  const [copying, setCopying] = useState<SlotBoardDTO | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedBoard, setSavedBoard] = useState<string | null>(null);
  /** A board made a moment ago opens with its name ready to type over. */
  const [justMade, setJustMade] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragData | null>(null);
  /** Who the resolver put on each slot, per board, for the inspector. */
  const [resolvedByBoard, setResolvedByBoard] = useState<Record<string, ReadonlyMap<string, Slot>>>({});

  const targets = showTargets(mic.views);

  // ── deep link: ?board=<id> scrolls to and selects that board ────────────
  const linkedBoard = linked && mic.boards.some((b) => b.id === linked) ? linked : null;
  const activeBoardId = mic.selection?.boardId ?? linkedBoard;
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedBoard || seeded.current === linkedBoard || !mic.loaded) return;
    seeded.current = linkedBoard;
    const first = (mic.boardsMap[linkedBoard] ?? []).find((s) => !isSpacer(s));
    if (first) mic.select(first.id);
  }, [linkedBoard, mic]);

  const sensors = useSensors(
    // Mouse and touch separately: a single PointerSensor claims a touch gesture
    // on touch-down, which stops the page scrolling on a phone. See the note in
    // use-stage-settings.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(e: DragStartEvent) {
    const data = e.active.data.current as DragData | undefined;
    if (!data) return;
    setDragging(data);
    mic.select(data.drag.id);
  }
  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const drag = (e.active.data.current as DragData | undefined)?.drag;
    const drop = (e.over?.data.current as DropData | undefined)?.drop;
    if (drag && drop) mic.mutate((b) => applyDrop(b, drag, drop));
  }

  const dialogs: BoardDialogs = {
    copyFrom: setCopying,
    chargers: setChargers,
    remove: setDeleting,
    savedLayouts: (boardId) => {
      setSavedBoard(boardId);
      setSavedOpen(true);
    },
  };

  // ── the inspector's slot ────────────────────────────────────────────────
  const sel = mic.selection;
  const selBoard = sel ? mic.boards.find((b) => b.id === sel.boardId) : undefined;

  async function applyChargers(boardId: string, columnWidthIn: number | null, displayWidths: { target: ShowTarget; widthIn: number }[]) {
    await mic.setColumnWidth(boardId, columnWidthIn);
    // Only what the operator applied: each screen and widget has its own display width.
    for (const w of displayWidths) await mic.setDisplayWidth(w.target, w.widthIn);
  }

  const where = (() => {
    if (!sel) return "";
    const cols = itemsOf(mic.boardsMap[sel.boardId] ?? []);
    const ci = cols.findIndex((c) => c.some((s) => s.id === sel.slotId));
    if (ci < 0) return "";
    const n = cols.slice(0, ci + 1).filter((c) => !c.every(isSpacer)).length;
    const row = cols[ci]!.findIndex((s) => s.id === sel.slotId);
    return `column ${n}${row > 0 ? `, row ${row + 1}` : ""}`;
  })();

  if (mic.boardsLoading) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <Loader2Icon className="size-5 animate-spin text-fg-subtle" />
      </div>
    );
  }
  if (mic.boardsError) {
    return <ErrorNote>Couldn't load the boards: {errorMessage(mic.boardsError)}.</ErrorNote>;
  }

  return (
    <div className="flex flex-col gap-4 pb-[50vh] max-sm:pb-24" data-mic-slots-page>
      {router && <LeaveGuard dirty={mic.dirty} count={mic.dirtyIds.length} />}
      <TopBar mic={mic} savedOpen={savedOpen} onSavedOpen={setSavedOpen} savedBoardId={savedBoard ?? sel?.boardId ?? mic.boards[0]?.id ?? null} />
      {mic.targetsFailed != null && (
        <ErrorNote>Couldn't read a board's layouts: {errorMessage(mic.targetsFailed)}. Boards that failed show as empty; do not save over them.</ErrorNote>
      )}
      <div className="lg:flex lg:items-start lg:gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          {mic.boards.length === 0 ? (
            <EmptyState
              title="No boards yet"
              hint="A board is one set of mic slots that screens and layout widgets show."
              action={
                <Button variant="accent" size="medium" onClick={() => setNewOpen(true)}>
                  <PlusIcon className="size-3.5" />
                  New board
                </Button>
              }
            />
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={collide}
              // Scrolls the page when a card is carried to its top or bottom edge, as it
              // must to reach a board below the fold, but over a thinner band than the
              // default fifth: a zone a card is about to be dropped on, near an edge,
              // should not scroll out from under it.
              autoScroll={{ threshold: { x: 0.1, y: 0.1 }, acceleration: 6 }}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragCancel={() => setDragging(null)}
            >
              {mic.boards.map((b) => (
                <BoardSection
                  key={b.id}
                  mic={mic}
                  board={b}
                  targets={targets}
                  active={activeBoardId === b.id}
                  dialogs={dialogs}
                  startRenaming={justMade === b.id}
                  onResolved={(id, map) => setResolvedByBoard((prev) => (prev[id] === map ? prev : { ...prev, [id]: map }))}
                />
              ))}
              <DragOverlay dropAnimation={null}>
                {dragging && (
                  <div className="rounded-lg border border-line-strong bg-popover px-3 py-2 text-footnote font-medium text-fg shadow-lg">{dragging.label}</div>
                )}
              </DragOverlay>
            </DndContext>
          )}
          {mic.boards.length > 0 && (
            <Button variant="transparent" size="medium" className="h-11 rounded-xl border border-dashed border-line-strong text-fg-muted" onClick={() => setNewOpen(true)}>
              <PlusIcon className="size-3.5" />
              New board
            </Button>
          )}
          <PlanCheck mic={mic} />
        </div>
        <aside aria-label="Inspector" className="mt-4 flex w-full flex-col gap-3.5 lg:sticky lg:top-14 lg:mt-0 lg:w-[340px] lg:shrink-0">
          {sel && mic.selectedSlot && selBoard ? (
            isSpacer(mic.selectedSlot) ? (
              <SpacerInspector
                slot={mic.selectedSlot}
                boardName={selBoard.name}
                aligned={selBoard.columnWidthIn != null}
                onChange={(fn) => mic.updateSlot(sel.slotId, fn)}
                onRemove={() => mic.removeSelected(sel.slotId)}
              />
            ) : (
              <SlotInspector
                slot={mic.selectedSlot}
                resolved={resolvedByBoard[sel.boardId]?.get(sel.slotId)}
                boardName={selBoard.name}
                where={where}
                columnWidthIn={selBoard.columnWidthIn}
                stack={stackState(mic.boardsMap, sel.slotId)}
                sharesWith={makeSharesWith(mic.boardsMap[sel.boardId] ?? [])(mic.selectedSlot)}
                planLabel={mic.side === "plan" ? mic.label : null}
                wirelessChannels={wirelessChannels}
                onChange={(fn) => mic.updateSlot(sel.slotId, fn)}
                onToggleStack={() => mic.toggleStack(sel.slotId)}
                onDuplicate={() => mic.duplicateSlot(sel.slotId)}
                onRemove={() => mic.removeSelected(sel.slotId)}
              />
            )
          ) : (
            <p className="text-footnote text-fg-muted">Select a slot to edit who fills it, its hardware and where it sits.</p>
          )}
          <p className="rounded-[10px] bg-fill px-3.5 py-3 text-caption1 leading-normal text-fg-muted">
            Drag a card into a gap to make it its own column, or onto the lower half of another card to stack it. The bar on top of a
            column drags the whole stack. Cards also move between boards. With a card focused, the arrow keys move it, Shift+Down stacks
            it onto the column to its left, Shift+Up takes it out of a stack, and Delete removes it.
          </p>
        </aside>
      </div>

      <NewBoardDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        boards={mic.boards}
        presets={presets}
        targets={targets}
        defaultFromBoardId={sel?.boardId ?? null}
        onCreate={async (input) => {
          const id = await mic.createBoard(input);
          if (id) {
            setJustMade(id);
            void setLinked(id, { replace: true });
          }
        }}
      />
      <DeleteBoardDialog
        key={deleting?.id ?? "none"}
        board={deleting}
        others={mic.boards.filter((b) => b.id !== deleting?.id)}
        onClose={() => setDeleting(null)}
        onDelete={async (id, replacement) => {
          await mic.deleteBoard(id, replacement);
        }}
      />
      <ChargerLayoutDialog
        key={chargers?.id ?? "none"}
        board={chargers}
        screens={targets
          .filter((t) => chargers !== null && t.boardId === chargers.id)
          .map((t) => ({ target: t, displayWidthIn: displayWidthOf(t, mic.views) }))}
        onClose={() => setChargers(null)}
        onApply={applyChargers}
      />
      {copying && (
        <CopyFromDialog
          title={`Copy over ${copying.name}`}
          description={`Replaces ${copying.name}'s layout for ${mic.side === "plan" ? mic.label : `${mic.typeName ?? "the service type"} default`}. A service type means its default; a plan means that plan's own layout.`}
          boards={mic.boards.filter((b) => b.id !== copying.id)}
          onClose={() => setCopying(null)}
          onCopy={async (from, sourceName) => {
            await mic.copyInto(copying.id, from, sourceName);
          }}
        />
      )}
    </div>
  );
}
