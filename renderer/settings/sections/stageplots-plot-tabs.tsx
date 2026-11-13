// stageplots-plot-tabs.tsx — a venue's plots as tabs in the editor, the star on
// the default, and the selected plot's menu: Rename, Duplicate, Set as
// default, Delete. Each saves at once; New, Duplicate and Delete first ask the
// editor whether the selected plot can be left (unsaved changes). The default plot cannot be deleted
// until another is the default, so its Delete is not offered. Deleting a plot that
// plans use clears those plans' overrides, and its confirm names the plans.

import { useRef, useState } from "react";
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
    const plans = plansUsing?.(plot.id) ?? [];
    const message =
      `It is removed from ${venue.name}. Its background stays.` +
      (plans.length === 0
        ? ""
        : ` ${plans.length === 1 ? "The plan" : `The ${plans.length} plans`} using it go back to the default plot: ${plans.join(", ")}.`);
    if (!(await confirm({ title: `Delete ${plot.name}?`, message, confirmLabel: "Delete plot", destructive: true }))) return;
    if (!(await leaving())) return;
    await run(() => stageplotsApi.deletePlot(plot.id));
  };
  const finishRename = async (plot: Plot, name: string | null) => {
    renamingRef.current = false;
    setRenaming(null);
    if (name !== null && name.trim() && name !== plot.name) await run(() => stageplotsApi.updatePlot(plot.id, { name }));
  };

  return (
    <div className="mb-2.5">
      <div className="flex items-end gap-3 border-b border-line">
        <div role="tablist" aria-label={`Plots in ${venue.name}`} className="flex min-w-0 flex-wrap items-end gap-0.5">
          {plots.map((p) => {
            const isSelected = p.id === selected?.id;
            const isDefault = p.id === venue.defaultPlotId;
            return (
              <div key={p.id} className="relative flex items-center">
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
                  <button type="button" role="tab" aria-selected={isSelected} onClick={() => onSelect(p.id)} className={tabClass(isSelected)}>
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
                        <DropdownMenu.Separator className="my-1 h-px bg-line" />
                        <DropdownMenu.Item className={MENU_ITEM_DANGER} disabled={isDefault} onSelect={() => void remove(p)}>
                          Delete…
                          {isDefault && <Why>Make another the default first</Why>}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className={cn(iconButton, "mb-1 size-7")}
            aria-label="New plot"
            disabled={plots.length >= STAGEPLOT_LIMITS.plotsPerVenue}
            onClick={() => void add()}
          >
            <PlusIcon className="size-4" />
          </button>
        </div>
      </div>
      <SaveError message={error} className="mt-1.5" />
    </div>
  );
}
