// stageplots-plot-tabs.tsx — a venue's plots as tabs in the editor, the star on
// the default, and the selected plot's menu: Rename, Duplicate, Set as default,
// Move left, Move right, Delete. Each saves at once; New, Duplicate and Delete
// first ask the editor whether the selected plot can be left (unsaved changes).
//
// A double-click on a tab renames it in place. Dragging a tab along the row
// reorders the plots (pointer events, so a mouse, pen or finger alike); a press
// that never moves past DRAG_SLOP_PX is an ordinary click. With no plots the
// add button reads "Add plot", and is a bare + after that.
//
// Deleting the default makes the first plot left the default, and the confirm
// says which; deleting the last plot leaves the venue empty. Deleting a plot that
// plans use clears those plans' overrides, and its confirm names the plans.

import { Fragment, useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";

import { STAGEPLOT_LIMITS, type Plot, type VenueView } from "@main/types/stageplots";

import { MENU_ITEM, MENU_ITEM_DANGER, menuContent } from "../../components/ui";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { useContextMenuState, useContextMenuTrigger } from "../../components/ui/context-menu-trigger";
import { confirm } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { moveTo } from "../../lib/list-move";
import { cn } from "../../lib/cn";
import { usePressDrag } from "../../lib/use-press-drag";
import { tabClass } from "../../main/stageplots/doc-helpers";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { DraftDot, SaveError, iconButton, type Save } from "./stageplots-shared";

/** How far, in screen pixels, a press on a tab moves before it is a drag and not a click. */
const DRAG_SLOP_PX = 5;

function Star() {
  return (
    <svg viewBox="0 0 24 24" className="size-3 fill-warn-9" role="img" aria-label="Default plot">
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z" />
    </svg>
  );
}

/** Why a row cannot be chosen, after its label. */
function Why({ children }: { children: string }) {
  return <small className="ml-auto pl-3 text-[11px] text-fg-subtle">{children}</small>;
}

/** What the delete confirm says: what goes, which plot takes over as default, which plans fall back. */
export function deleteMessage(venue: VenueView, plots: readonly Plot[], plot: Plot, plans: readonly string[]): string {
  const left = plots.filter((p) => p.id !== plot.id);
  const parts = [`It is removed from ${venue.name}. Its background stays.`];
  if (plot.id === venue.defaultPlotId) {
    parts.push(left.length > 0 ? `${left[0].name} becomes the default.` : `${venue.name} is left with no plots.`);
  }
  if (plans.length > 0) parts.push(`${plans.length === 1 ? "The plan" : `The ${plans.length} plans`} using it go back to the default plot: ${plans.join(", ")}.`);
  return parts.join(" ");
}

export function PlotTabs({
  venue,
  plots,
  selected,
  onSelect,
  beforeSwitch,
  plansUsing,
  save,
  drafted,
}: {
  venue: VenueView;
  plots: Plot[];
  selected: Plot | null;
  onSelect: (plotId: string) => void;
  /** Plots with an unsaved draft kept on the server: each tab carries a dot. */
  drafted?: ReadonlySet<string>;
  /** Asked before anything that leaves the selected plot (New, Duplicate,
   *  Delete); false stops it. The editor stores the unsaved draft first, and
   *  asks only when it could not. */
  beforeSwitch?: () => Promise<boolean>;
  /** The plans whose override names a plot, by name ("Sun 15 Nov"): its delete hands them back to the default. */
  plansUsing?: (plotId: string) => string[];
  save: Save;
}) {
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Radix returns focus to the trigger when the menu closes, which is wrong for
  // a rename: onCloseAutoFocus checks this and focuses the name field instead.
  const renamingRef = useRef(false);
  // A rename started by double-click has no menu to wait for: focus the field once it is drawn.
  useEffect(() => {
    if (!renaming || renamingRef.current) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  // The order shown while a drag's save is on its way, so the tab does not jump back first.
  const [order, setOrder] = useState<string[] | null>(null);
  const shown = order ? order.map((id) => plots.find((p) => p.id === id)).filter((p): p is Plot => !!p) : plots;
  // A drag in progress: which tab, and the slot it would land in.
  const [dropAt, setDropAt] = useState<{ id: string; index: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const run = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    const r = await save(fn);
    setError(r.ok ? null : r.error);
    return r.ok ? r.value : null;
  };

  const leaving = async () => (beforeSwitch ? beforeSwitch() : true);

  const add = async () => {
    if (!(await leaving())) return;
    const made = await run(() =>
      stageplotsApi.createPlot({ venueId: venue.id, name: `Plot ${plots.length + 1}`, backgroundId: selected?.backgroundId ?? null }),
    );
    if (made) onSelect(made.id);
  };
  const duplicate = async (plot: Plot) => {
    if (!(await leaving())) return;
    const copy = await run(() => stageplotsApi.duplicatePlot(plot.id));
    if (copy) onSelect(copy.id);
  };
  const remove = async (plot: Plot) => {
    // The delete is asked first, so a Cancel there never costs unsaved work.
    const message = deleteMessage(venue, plots, plot, plansUsing?.(plot.id) ?? []);
    if (!(await confirm({ title: `Delete ${plot.name}?`, message, confirmLabel: "Delete plot", destructive: true }))) return;
    // Only the selected plot's unsaved changes are at stake: deleting another plot (from its
    // right-click menu) neither asks about them nor discards them.
    if (plot.id === selected?.id && !(await leaving())) return;
    await run(() => stageplotsApi.deletePlot(plot.id));
  };
  const reorder = async (ids: string[]) => {
    if (ids.every((id, i) => id === plots[i]?.id)) return;
    setOrder(ids);
    await run(() => stageplotsApi.reorderPlots(venue.id, ids));
    setOrder(null);
  };
  const finishRename = async (plot: Plot, name: string | null) => {
    renamingRef.current = false;
    setRenaming(null);
    if (name !== null && name.trim() && name !== plot.name) await run(() => stageplotsApi.updatePlot(plot.id, { name }));
  };

  /** The tabs but the dragged one, with where each sits on screen. */
  const otherTabs = (id: string) =>
    [...(rowRef.current?.querySelectorAll<HTMLElement>("[data-plot-tab]") ?? [])]
      .filter((el) => el.dataset.plotTab !== id)
      .map((el) => el.getBoundingClientRect());
  /**
   * The slot a pointer at (`clientX`, `clientY`) would drop the dragged tab into, among the
   * other tabs. The row wraps, so a tab is before the pointer when its row is above the
   * pointer's, or it is in the same row and its middle is left of the pointer.
   */
  const slotAt = (id: string, clientX: number, clientY: number): number => {
    const rects = otherTabs(id);
    if (rects.length === 0) return 0;
    // The pointer's row: the one under it, or the nearest when it is above or below them all.
    const row = rects.reduce((best, r) => {
      const gap = (q: DOMRect) => (clientY < q.top ? q.top - clientY : clientY > q.bottom ? clientY - q.bottom : 0);
      return gap(r) < gap(best) ? r : best;
    });
    const sameRow = (r: DOMRect) => r.top < row.bottom && r.bottom > row.top;
    return rects.filter((r) => (sameRow(r) ? r.left + r.width / 2 < clientX : r.top < row.top)).length;
  };
  const pressDrag = usePressDrag<string>({
    slop: DRAG_SLOP_PX,
    axis: "x",
    onMove: (id, e) => setDropAt({ id, index: slotAt(id, e.clientX, e.clientY) }),
    onDrop: (id, e) => void reorder(moveTo(shown.map((p) => p.id), id, slotAt(id, e.clientX, e.clientY))),
    onEnd: () => setDropAt(null),
  });
  const onTabPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0 || renaming || plots.length < 2) return;
    pressDrag.press(e, id);
  };

  /** What can be done to a plot: the selected tab's ⋯ menu and any tab's right-click menu list the same. */
  const actionsFor = (p: Plot): TabAction[] => {
    const index = shown.indexOf(p);
    const isDefault = p.id === venue.defaultPlotId;
    const ids = shown.map((x) => x.id);
    return [
      { label: "Rename", rename: true, run: () => setRenaming(p.id) },
      { label: "Duplicate", disabled: plots.length >= STAGEPLOT_LIMITS.plotsPerVenue, run: () => void duplicate(p) },
      { label: "Set as default", disabled: isDefault, why: isDefault ? "Already the default" : undefined, run: () => void run(() => stageplotsApi.setDefault(venue.id, p.id)) },
      { label: "Move left", disabled: index === 0, run: () => void reorder(moveTo(ids, p.id, index - 1)) },
      { label: "Move right", disabled: index === shown.length - 1, run: () => void reorder(moveTo(ids, p.id, index + 1)) },
      { label: "Delete…", danger: true, separated: true, run: () => void remove(p) },
    ];
  };
  const { menu, open, close: closeMenu } = useContextMenuState();
  const openMenu = (p: Plot, at: { x: number; y: number }) =>
    open(
      at,
      actionsFor(p).flatMap((a): ContextMenuItem[] => [
        ...(a.separated ? [{ separator: true }] : []),
        { label: a.label, disabled: a.disabled, danger: a.danger, onSelect: a.run },
      ]),
    );

  /** The tab order with the dragged tab left out, for where the drop marker goes. */
  const others = dropAt ? shown.filter((p) => p.id !== dropAt.id) : shown;
  const marker = <span aria-hidden className="mb-1.5 h-6 w-0.5 shrink-0 self-end rounded-full bg-accent" data-testid="tab-drop-marker" />;

  return (
    <div className="mb-2.5">
      <div className="flex items-end gap-3 border-b border-line">
        <div ref={rowRef} role="tablist" aria-label={`Plots in ${venue.name}`} className="flex min-w-0 flex-wrap items-end gap-0.5">
          {shown.map((p) => {
            const isSelected = p.id === selected?.id;
            const isDefault = p.id === venue.defaultPlotId;
            const at = others.indexOf(p);
            return (
              <div key={p.id} className="relative flex items-center">
                {dropAt && at === dropAt.index && p.id !== dropAt.id && marker}
                {renaming === p.id ? (
                  <Input
                    ref={inputRef}
                    aria-label="Plot name"
                    defaultValue={p.name}
                    maxLength={STAGEPLOT_LIMITS.nameChars}
                    className="mb-1 h-7 w-40"
                    onBlur={(e) => void finishRename(p, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") void finishRename(p, null);
                    }}
                  />
                ) : (
                  <TabButton
                    plot={p}
                    selected={isSelected}
                    dragging={dropAt?.id === p.id}
                    onMenu={(at) => openMenu(p, at)}
                    onClick={(e) => {
                      if (!pressDrag.claimClick(e)) onSelect(p.id);
                    }}
                    onDoubleClick={() => setRenaming(p.id)}
                    onPointerDown={(e) => onTabPointerDown(e, p.id)}
                    onPointerMove={pressDrag.move}
                    onPointerUp={pressDrag.up}
                    onPointerCancel={pressDrag.cancel}
                  >
                    {p.name}
                    {isDefault && <Star />}
                    {drafted?.has(p.id) && <DraftDot />}
                  </TabButton>
                )}
                {isSelected && renaming !== p.id && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button type="button" className={cn(iconButton, "size-6")} aria-label="Plot actions">
                        <MoreHorizontalIcon className="size-3.5" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="start"
                        sideOffset={4}
                        className={menuContent("min-w-52")}
                        onCloseAutoFocus={(e) => {
                          if (!renamingRef.current) return;
                          // Focus the field HERE, after the menu is gone: focused any
                          // earlier, the open menu's focus trap takes it straight back.
                          e.preventDefault();
                          inputRef.current?.focus();
                          inputRef.current?.select();
                        }}
                      >
                        {actionsFor(p).map((a) => (
                          <Fragment key={a.label}>
                            {a.separated && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
                            <DropdownMenu.Item
                              className={a.danger ? MENU_ITEM_DANGER : cn(MENU_ITEM, "data-[disabled]:text-fg-subtle")}
                              disabled={a.disabled}
                              onSelect={() => {
                                if (a.rename) renamingRef.current = true;
                                a.run();
                              }}
                            >
                              {a.label}
                              {a.why && <Why>{a.why}</Why>}
                            </DropdownMenu.Item>
                          </Fragment>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
              </div>
            );
          })}
          {dropAt && dropAt.index >= others.length && marker}
          {plots.length === 0 ? (
            <button type="button" className={cn(iconButton, "mb-1 inline-flex h-7 gap-1 px-2 text-footnote font-medium")} onClick={() => void add()}>
              <PlusIcon className="size-4" />
              Add plot
            </button>
          ) : (
            <button
              type="button"
              className={cn(iconButton, "mb-1 size-7")}
              aria-label="New plot"
              title="New plot"
              disabled={plots.length >= STAGEPLOT_LIMITS.plotsPerVenue}
              onClick={() => void add()}
            >
              <PlusIcon className="size-4" />
            </button>
          )}
        </div>
      </div>
      <SaveError message={error} className="mt-1.5" />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

/** One thing a plot's menus offer. */
interface TabAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** A line above it. */
  separated?: boolean;
  /** Why it cannot be chosen, after its label in the ⋯ menu. */
  why?: string | undefined;
  /** Rename: the ⋯ menu hands focus to the name field once it has closed. */
  rename?: boolean;
}

/**
 * A plot's tab: a press selects it, a drag reorders, a double-click renames, and a
 * right-click or long press opens its menu. A drag under way cancels the long press.
 */
function TabButton({
  plot,
  selected,
  dragging,
  onMenu,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  ...rest
}: {
  plot: Plot;
  selected: boolean;
  dragging: boolean;
  onMenu: (at: { x: number; y: number }) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  /** True once the press is a drag. */
  onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => boolean;
  onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onDoubleClick: () => void;
  children: ReactNode;
}) {
  const trigger = useContextMenuTrigger(onMenu);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-plot-tab={plot.id}
      title="Double-click to rename, drag to reorder, right-click for more"
      {...rest}
      onContextMenu={trigger.onContextMenu}
      onClickCapture={trigger.onClickCapture}
      onPointerDown={(e) => {
        trigger.onPointerDown(e);
        onPointerDown(e);
      }}
      onPointerMove={(e) => {
        trigger.onPointerMove(e);
        if (onPointerMove(e)) trigger.cancel();
      }}
      onPointerUp={(e) => {
        trigger.onPointerUp(e);
        onPointerUp(e);
      }}
      onPointerCancel={(e) => {
        trigger.onPointerCancel(e);
        onPointerCancel(e);
      }}
      style={trigger.style}
      className={cn(tabClass(selected), "touch-pan-y select-none", dragging && "opacity-50")}
    />
  );
}
