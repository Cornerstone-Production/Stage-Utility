// One board on the page: its header, a screen-shaped preview of the real slot
// cards, and the line under it about chargers.

import { useQueries } from "@tanstack/react-query";
import { CheckIcon, ChevronRightIcon, LayoutGridIcon, MonitorIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { Button, Input, MENU_ITEM, MENU_ITEM_DANGER, ErrorNote, menuContent } from "../../components/ui";
import { cn } from "../../lib/cn";
import { invoke as ipc } from "../../lib/api";
import { useNameDraft } from "../../lib/use-name-draft";
import { useStageState } from "../../main/use-stage-state";
import { useUpcomingPlans } from "../../settings/sections/plan-switcher";
import { SlotsPreviewNote } from "../../settings/sections/slots-preview-target";
import { namedType } from "../../settings/sections/slots-target-pill";
import { plural } from "@main/services/plural";
import { groupColumns, isSpacerColumn } from "../../components/slots-columns";
import { BoardPreview, EmptyBoardDrop, chargerBanks } from "./board-preview";
import { slotCount } from "./board-model";
import { showLabel } from "./board-dialogs";
import { useBoardPreview } from "./use-board-preview";
import type { MicSlots, ShowTarget } from "./use-mic-slots";

/** What a screen is assumed to be when none of the ones showing a board says. */
export const FALLBACK_DISPLAY_WIDTH_IN = 32.25;

export interface BoardDialogs {
  copyFrom: (board: SlotBoardDTO) => void;
  chargers: (board: SlotBoardDTO) => void;
  remove: (board: SlotBoardDTO) => void;
  savedLayouts: (boardId: string) => void;
}

/** The display width the screens showing a board give it: the first that sets one. */
export function displayWidthFor(board: SlotBoardDTO, views: readonly View[]): number {
  for (const s of board.shownOn) {
    const v = views.find((x) => x.id === s.viewId);
    if (!v) continue;
    if (s.kind === "view" && v.slotsLayout?.displayWidthIn) return v.slotsLayout.displayWidthIn;
    if (s.kind === "object") {
      const walk = (objs: LayoutObject[] | undefined): number | null => {
        for (const o of objs ?? []) {
          if (o.id === s.id && o.config.type === "slots-grid") return o.config.displayWidthIn ?? o.config.slotsLayout?.displayWidthIn ?? null;
          const inner = walk(o.children);
          if (inner) return inner;
        }
        return null;
      };
      const w = walk(v.layout?.objects);
      if (w) return w;
    }
  }
  return FALLBACK_DISPLAY_WIDTH_IN;
}

/** How wide the columns add up to, in inches, against the display's. */
export function usedWidthIn(slots: readonly Slot[], layout: SlotsLayout): number {
  return groupColumns(slots).reduce((sum, c) => sum + (c[0]?.widthIn ?? layout.columnWidthIn), 0);
}

function ShownChip({ t }: { t: SlotBoardShownOn }) {
  const Icon = t.kind === "object" ? LayoutGridIcon : MonitorIcon;
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-fill px-2 text-caption1 text-fg">
      <Icon className="size-3 text-fg-muted" />
      {t.kind === "object" ? `${t.name} · widget` : t.name}
    </span>
  );
}

function BoardMenu({
  mic,
  board,
  targets,
  dialogs,
  onRename,
}: {
  mic: MicSlots;
  board: SlotBoardDTO;
  targets: ShowTarget[];
  dialogs: BoardDialogs;
  onRename: () => void;
}) {
  const t = mic.targetsById.get(board.id);
  const canRevert = mic.side === "plan" && t?.overrideSlots != null;
  // A plan layout to promote: the saved one, or unsaved edits, which are saved first.
  const canPromote = mic.side === "plan" && (t?.overrideSlots != null || mic.dirtyIds.includes(board.id));
  const name = (id: string | null) => (id ? (mic.boards.find((b) => b.id === id)?.name ?? null) : null);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="transparent" size="small" iconOnly aria-label={`Board actions for ${board.name}`}>
          <MoreHorizontalIcon className="size-4 text-fg-muted" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={menuContent()}>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={onRename}>Rename</DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void mic.duplicateBoard(board.id)}>Duplicate board</DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={cn(MENU_ITEM, "justify-between")}>
              Shown on
              <span className="flex items-center gap-1 text-fg-muted">
                {plural(board.shownOn.length, "place")}
                <ChevronRightIcon className="size-3.5" />
              </span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className={menuContent()} sideOffset={4}>
                <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
                  Show {board.name} on
                </DropdownMenu.Label>
                {targets.length === 0 && <div className="px-2 py-1.5 text-footnote text-fg-muted">No slots screens or widgets exist yet.</div>}
                {targets.map((t2) => {
                  const here = t2.boardId === board.id;
                  const elsewhere = !here ? name(t2.boardId) : null;
                  return (
                    <DropdownMenu.CheckboxItem
                      key={t2.id}
                      checked={here}
                      // Checking points it here. Moving it off is done by checking
                      // it on the board that should show it instead.
                      disabled={here}
                      className={cn(MENU_ITEM, "gap-2 data-[disabled]:opacity-100")}
                      onCheckedChange={() => void mic.showOn(t2, board.id)}
                    >
                      <span className="inline-flex w-3.5 justify-center">
                        <DropdownMenu.ItemIndicator><CheckIcon className="size-3.5 text-accent" /></DropdownMenu.ItemIndicator>
                      </span>
                      {showLabel(t2)}
                      {elsewhere && <span className="text-fg-muted">· shows {elsewhere}</span>}
                    </DropdownMenu.CheckboxItem>
                  );
                })}
                <div className="px-2 pt-1 text-caption2 text-fg-subtle">Check a screen on another board to move it there.</div>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => dialogs.copyFrom(board)}>Copy this board from…</DropdownMenu.Item>
          <DropdownMenu.Item className={cn(MENU_ITEM, "data-[disabled]:opacity-40")} disabled={!canRevert} onSelect={() => void mic.revertBoard(board.id)}>
            Revert this board to the default
          </DropdownMenu.Item>
          <DropdownMenu.Item className={cn(MENU_ITEM, "data-[disabled]:opacity-40")} disabled={!canPromote} onSelect={() => void mic.promoteBoard(board.id)}>
            Set this board as the default
          </DropdownMenu.Item>
          <DropdownMenu.Item className={MENU_ITEM} onSelect={() => dialogs.chargers(board)}>Charger layout…</DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={MENU_ITEM_DANGER} onSelect={() => dialogs.remove(board)}>Delete board…</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The empty state's "Copy the <type> layout": the first other service type this
 *  board has a layout for. */
function useOtherTypeLayout(boardId: string, currentTypeId: string | null, enabled: boolean) {
  const { plans } = useUpcomingPlans({ enabled });
  const others = [...new Map(plans.filter((p) => p.serviceTypeId !== currentTypeId).map((p) => [p.serviceTypeId, p.serviceTypeName])).entries()];
  const qs = useQueries({
    queries: others.map(([id]) => ({
      queryKey: ["boards:contents", boardId, id, null],
      queryFn: () => ipc<SlotTargetsDTO>("boards:targets", { id: boardId, serviceTypeId: id, planId: null }),
      enabled,
    })),
  });
  const at = qs.findIndex((q) => (q.data?.defaultSlots.length ?? 0) > 0);
  return at >= 0 ? { id: others[at]![0], name: others[at]![1] } : null;
}

export function BoardSection({
  mic,
  board,
  targets,
  active,
  dialogs,
  startRenaming,
  onResolved,
}: {
  mic: MicSlots;
  board: SlotBoardDTO;
  targets: ShowTarget[];
  /** The board a deep link or the selection points at. */
  active: boolean;
  dialogs: BoardDialogs;
  startRenaming?: boolean;
  /** Hands the page who the resolver put on each slot, for its inspector. */
  onResolved: (boardId: string, resolved: ReadonlyMap<string, Slot>) => void;
}) {
  const { state } = useStageState();
  const slots = mic.boardsMap[board.id] ?? [];
  const target = mic.serviceTypeId ? { serviceTypeId: mic.serviceTypeId, planId: mic.side === "plan" ? mic.planId : null } : null;
  const preview = useBoardPreview(slots, target);
  useEffect(() => onResolved(board.id, preview.resolved), [board.id, preview.resolved, onResolved]);
  const [renaming, setRenaming] = useState(!!startRenaming);
  const name = useNameDraft(board.name, (renamed) => void mic.renameBoard(board.id, renamed));
  const ref = useRef<HTMLElement>(null);

  // A deep link, or a board just made, scrolls into view.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [active]);

  const displayWidthIn = displayWidthFor(board, mic.views);
  const layout: SlotsLayout | null = board.columnWidthIn != null ? { displayWidthIn, columnWidthIn: board.columnWidthIn } : null;
  const used = layout ? usedWidthIn(slots, layout) : 0;
  const over = layout ? used > layout.displayWidthIn + 0.01 : false;
  const banks = chargerBanks(slots, layout);
  const empty = mic.loaded && slots.length === 0;
  const selectedHere = mic.selection?.boardId === board.id ? mic.selection.slotId : null;
  const failed = mic.saveError?.boardId === board.id ? mic.saveError.message : null;
  const typeName = mic.typeName;
  const other = useOtherTypeLayout(board.id, mic.serviceTypeId, empty);
  const dirty = mic.dirtyIds.includes(board.id);

  const actions = {
    select: mic.select,
    nudge: mic.nudgeSlot,
    stack: mic.stackSlot,
    unstack: mic.unstackSlot,
    remove: mic.removeSelected,
  };

  return (
    <section
      ref={ref}
      id={`board-${board.id}`}
      data-board-id={board.id}
      data-active={active ? "true" : undefined}
      data-dirty={dirty ? "true" : undefined}
      aria-label={board.name}
      className={cn(
        "overflow-hidden rounded-xl border bg-surface shadow-[var(--su-shadow-1)]",
        active ? "border-accent" : failed ? "border-danger-9" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-2.5">
        {renaming ? (
          <Input
            value={name.draft}
            autoFocus
            aria-label={`Rename ${board.name}`}
            className="w-56 text-subheadline font-semibold"
            onChange={(e: ChangeEvent<HTMLInputElement>) => name.setDraft(e.target.value)}
            onBlur={() => {
              name.commit();
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                name.setDraft(board.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h2 className="text-subheadline font-semibold text-fg">{board.name}</h2>
        )}
        <span className="text-caption1 text-fg-muted">Shown on</span>
        {board.shownOn.length > 0 ? board.shownOn.map((s) => <ShownChip key={`${s.kind}:${s.id}`} t={s} />) : <span className="text-caption1 text-fg-subtle">nothing yet</span>}
        <span className="text-caption1 text-fg-muted">· {plural(slotCount(slots), "slot")}</span>
        {dirty && <span className="text-caption2 text-fg-muted">unsaved</span>}
        <span className="flex-1" />
        <Button variant="filled" size="small" onClick={() => mic.addSlot(board.id)}>
          <PlusIcon className="size-3.5 text-fg-muted" />
          Slot
        </Button>
        <Button variant="filled" size="small" onClick={() => mic.addSpacer(board.id)}>
          <PlusIcon className="size-3.5 text-fg-muted" />
          Spacer
        </Button>
        <BoardMenu mic={mic} board={board} targets={targets} dialogs={dialogs} onRename={() => { name.setDraft(board.name); setRenaming(true); }} />
      </div>
      {failed && <ErrorNote className="m-3">{failed}</ErrorNote>}

      <div className="flex flex-col items-center gap-2 bg-black/[0.04] p-4 dark:bg-black/25">
        <div className="kiosk-surface aspect-video w-full max-w-[1056px] rounded-md p-3 shadow-[0_0_0_6px_#1b1b1b,0_0_0_7px_rgba(255,255,255,0.10)]">
          {empty ? (
            <EmptyBoardDrop boardId={board.id}>
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center" data-mic-empty={board.id}>
              <span className="text-subheadline font-medium text-fg">
                {mic.hasPlan || typeName ? `No ${typeName ? `${typeName} ` : ""}layout for this board yet` : "No layout for this board yet"}
              </span>
              <span className="max-w-md text-caption1 text-fg-muted">
                {board.shownOn.length > 0
                  ? `${board.shownOn[0]!.name} shows an empty board${typeName ? ` for ${typeName} plans` : ""} until you make one.`
                  : "Nothing shows this board yet."}
              </span>
              <div className="flex flex-wrap justify-center gap-1.5">
                {other && (
                  <Button variant="accent" size="medium" onClick={() => void mic.copyInto(board.id, { fromServiceTypeId: other.id }, `${other.name} default`)}>
                    Copy {namedType(other.name)} layout
                  </Button>
                )}
                <Button variant="filled" size="medium" onClick={() => dialogs.savedLayouts(board.id)}>Recall a saved layout</Button>
                <Button variant="filled" size="medium" onClick={() => mic.addSlot(board.id)}>Start blank</Button>
              </div>
            </div>
            </EmptyBoardDrop>
          ) : (
            <BoardPreview
              boardId={board.id}
              slots={preview.slots}
              layout={layout}
              selectedId={selectedHere}
              highlighted={mic.highlighted}
              actions={actions}
              emptySlotLogo={state?.emptySlotLogo ?? null}
              defaultAvatar={state?.defaultAvatar ?? null}
            />
          )}
        </div>
        {preview.failure && (
          <span role="alert" data-mic-preview-failed className="text-caption1 text-danger-11" title={preview.failure}>
            {"Couldn't load this week's people, so the cards show the saved rows without names."}
          </span>
        )}
        {!empty && <SlotsPreviewNote resolution={preview.resolution} planLabel={mic.label} serviceTypeName={typeName} />}
        {banks.length > 0 && (
          <div className="relative h-3.5 w-full max-w-[1056px]" aria-hidden>
            {banks.map((b, i) => (
              <span
                key={i}
                className="absolute top-0 flex h-2.5 items-end justify-center rounded-b border-x border-b border-fg-subtle"
                style={{ left: `${b.startPct}%`, width: `${b.endPct - b.startPct}%` }}
              >
                <span className="translate-y-full pt-0.5 text-[10px] leading-none text-fg-subtle">Bank {i + 1}</span>
              </span>
            ))}
          </div>
        )}
        <div className={cn("flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-caption1", banks.length > 0 && "pt-2.5", over ? "text-danger-11" : "text-fg-muted")}>
          {layout ? (
            <span data-mic-width={over ? "over" : "ok"}>
              Aligned to chargers: using {used.toFixed(2)}″ of {layout.displayWidthIn.toFixed(2)}″
              {over ? ", over the display width; reduce widths or spacers." : ""}
            </span>
          ) : (
            <span>Columns share the width equally.</span>
          )}
          <span>·</span>
          <button type="button" className="text-accent hover:underline" onClick={() => dialogs.chargers(board)}>
            Charger layout
          </button>
          {groupColumns(slots).some(isSpacerColumn) && !layout && <span className="text-fg-subtle">Spacers count once the board is aligned.</span>}
        </div>
      </div>
    </section>
  );
}
