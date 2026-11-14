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

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";

import { STAGEPLOT_LIMITS, type Plot, type Venue } from "@main/types/stageplots";

import { MENU_ITEM, MENU_ITEM_DANGER, menuContent } from "../../components/ui";
import { confirm } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/cn";
import { tabClass } from "../../main/stageplots/doc-helpers";
import { stageplotsApi } from "../../main/stageplots/stageplots-api";
import { SaveError, iconButton, type Save } from "./stageplots-shared";

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

/** `ids` with `id` moved to sit at `to` (an index into the list without it). */
export function moved(ids: readonly string[], id: string, to: number): string[] {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** What the delete confirm says: what goes, which plot takes over as default, which plans fall back. */
export function deleteMessage(venue: Venue, plots: readonly Plot[], plot: Plot, plans: readonly string[]): string {
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
}: {
  venue: Venue;
  plots: Plot[];
  selected: Plot | null;
  onSelect: (plotId: string) => void;
  /** Asked before anything that leaves the selected plot (New, Duplicate,
   *  Delete); false stops it. The editor asks about unsaved changes. */
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
  // A drag in progress: which tab, from where, and the slot it would land in.
  const drag = useRef<{ id: string; pointerId: number; x: number; dragging: boolean } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; index: number } | null>(null);
  /** Set when a press ended as a drag: the click the browser sends after it is not a select. */
  const dragged = useRef(false);
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
    if (!(await leaving())) return;
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

  /** The slot a pointer at `clientX` would drop the dragged tab into, among the other tabs. */
  const slotAt = (id: string, clientX: number): number => {
    const tabs = [...(rowRef.current?.querySelectorAll<HTMLElement>("[data-plot-tab]") ?? [])].filter((el) => el.dataset.plotTab !== id);
    return tabs.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2 < clientX;
    }).length;
  };
  const onTabPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0 || renaming || plots.length < 2) return;
    dragged.current = false;
    drag.current = { id, pointerId: e.pointerId, x: e.clientX, dragging: false };
    // Held from the press, so a quick first move that leaves the tab is still this drag's.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onTabPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.dragging) {
      if (Math.abs(e.clientX - d.x) < DRAG_SLOP_PX) return;
      d.dragging = true;
    }
    setDropAt({ id: d.id, index: slotAt(d.id, e.clientX) });
  };
  const endDrag = (e: ReactPointerEvent<HTMLButtonElement>, drop: boolean) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDropAt(null);
    if (!d.dragging) return;
    dragged.current = true;
    if (drop) void reorder(moved(shown.map((p) => p.id), d.id, slotAt(d.id, e.clientX)));
  };
  useEffect(() => {
    if (!dropAt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      drag.current = null;
      dragged.current = true;
      setDropAt(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dropAt]);

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
            const index = shown.indexOf(p);
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
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    data-plot-tab={p.id}
                    title="Double-click to rename, drag to reorder"
                    onClick={() => {
                      if (dragged.current) {
                        dragged.current = false;
                        return;
                      }
                      onSelect(p.id);
                    }}
                    onDoubleClick={() => setRenaming(p.id)}
                    onPointerDown={(e) => onTabPointerDown(e, p.id)}
                    onPointerMove={onTabPointerMove}
                    onPointerUp={(e) => endDrag(e, true)}
                    onPointerCancel={(e) => endDrag(e, false)}
                    className={cn(tabClass(isSelected), "touch-pan-y select-none", dropAt?.id === p.id && "opacity-50")}
                  >
                    {p.name}
                    {isDefault && <Star />}
                  </button>
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
                        <DropdownMenu.Item
                          className={MENU_ITEM}
                          onSelect={() => {
                            renamingRef.current = true;
                            setRenaming(p.id);
                          }}
                        >
                          Rename
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className={MENU_ITEM} disabled={plots.length >= STAGEPLOT_LIMITS.plotsPerVenue} onSelect={() => void duplicate(p)}>
                          Duplicate
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={cn(MENU_ITEM, "data-[disabled]:text-fg-subtle")}
                          disabled={isDefault}
                          onSelect={() => void run(() => stageplotsApi.setDefault(venue.id, p.id))}
                        >
                          Set as default
                          {isDefault && <Why>Already the default</Why>}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={cn(MENU_ITEM, "data-[disabled]:text-fg-subtle")}
                          disabled={index === 0}
                          onSelect={() => void reorder(moved(shown.map((x) => x.id), p.id, index - 1))}
                        >
                          Move left
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className={cn(MENU_ITEM, "data-[disabled]:text-fg-subtle")}
                          disabled={index === shown.length - 1}
                          onSelect={() => void reorder(moved(shown.map((x) => x.id), p.id, index + 1))}
                        >
                          Move right
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="my-1 h-px bg-line" />
                        <DropdownMenu.Item className={MENU_ITEM_DANGER} onSelect={() => void remove(p)}>
                          Delete…
                        </DropdownMenu.Item>
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
    </div>
  );
}
