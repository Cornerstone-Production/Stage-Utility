// The tray Customize mode docks under the page: what is not in the sidebar, and
// the mode's own controls.
//
// Under the page rather than over it, so the page the sidebar sits beside stays
// in view. On a phone it is a bottom sheet, with the pinned sidebar above it.
// Its ground is the popover's, not surface-raised: in dark that one is a 5.5%
// white wash, and the sheet lies over the page.
//
// Its height is published as `--su-tray-h` on the document, measured by a
// ResizeObserver rather than read once after render: a measurement taken a frame
// early reads the tray before its tiles have laid out. jsdom lays nothing out,
// so this is checked in a browser, not in a test.

import { useEffect, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { PanelLeftCloseIcon, PlusIcon, RotateCcwIcon, FolderPlusIcon } from "lucide-react";

import { EMPTY_SIDEBAR, homeSectionIn, isConsoleId, resolveSidebar } from "@main/services/sidebar-arrangement";
import { Button } from "../components/ui";
import { useSidebarCollapsed } from "../lib/use-sidebar-collapsed";
import { cn } from "../lib/cn";
import { useCustomize } from "./customize-mode";
import type { RailDrag } from "./rail-drop";
import { addSection, newSectionId, restorePage } from "./sidebar-edits";

export function SidebarTray({ isMobile }: { isMobile: boolean }) {
  const customize = useCustomize();
  const { resolved, consoles, trayRef, describe, aim } = customize;
  const { collapsed } = useSidebarCollapsed();

  useEffect(() => {
    const el = trayRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--su-tray-h", `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--su-tray-h");
    };
  }, [trayRef]);

  const pages = resolved.hiddenPages;
  const hiddenConsoles = resolved.hiddenConsoles;
  const nothingHidden = pages.length === 0 && hiddenConsoles.length === 0;

  function restore(id: string) {
    if (isConsoleId(id)) customize.setConsoleShown(id, true);
    else customize.apply(restorePage(resolved, id));
  }

  return (
    <div
      ref={trayRef}
      role="region"
      aria-label="Customize"
      className={cn(
        "z-[12] flex flex-col gap-2.5 border-t border-line-strong bg-popover px-4 pt-3 pb-3.5",
        "shadow-[0_-10px_30px_rgba(0,0,0,0.08)]",
        isMobile
          ? "fixed inset-x-0 bottom-0 z-50 max-h-[52dvh] rounded-t-2xl pb-[calc(env(safe-area-inset-bottom)+0.875rem)]"
          : "relative max-h-[48%] shrink-0",
        aim.hiding && "shadow-[inset_0_0_0_2px_var(--su-danger-9),0_-10px_30px_rgba(0,0,0,0.08)]",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="m-0 text-[13px] font-semibold text-fg">Customize</h3>
        <span role="group" aria-label="What to customize" className="inline-flex gap-px rounded-lg bg-accent-soft p-0.5">
          <button
            type="button"
            aria-pressed="true"
            className="inline-flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-1 text-[12px] font-semibold text-fg shadow-(--su-shadow-1)"
          >
            <PanelLeftCloseIcon className="size-[13px] text-accent" />
            Sidebar
          </button>
        </span>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <p className="m-0 text-[12px] leading-4 text-fg-muted">
          Drag a page into the sidebar, along it to reorder, or out of it to hide it. Click a tile to put it back where it was.
        </p>
        {collapsed && !isMobile && (
          <div className="rounded-lg bg-fill px-2.5 py-2 text-[12px] leading-4 text-fg-muted">
            The sidebar opens out while you customize, and folds back when you press Done.
          </div>
        )}
        <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.07em] text-fg-subtle">Not in the sidebar</div>
        {nothingHidden ? (
          <div className="py-1.5 text-[12.5px] text-fg-subtle">Every page is in the sidebar. Drag one out to hide it.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {[...pages, ...hiddenConsoles].map((id) => {
              const d = describe(id);
              const home = isConsoleId(id) ? "Consoles" : homeSectionIn(resolved.sections, id).label || "the top";
              return (
                <Tile key={id} id={id} label={d?.label ?? id} icon={d?.icon} console={isConsoleId(id)} title={`Back to ${home}`} onClick={() => restore(id)} />
              );
            })}
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => customize.apply(addSection(resolved, newSectionId(resolved)))}
            className="flex h-[34px] items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface pr-3 pl-2.5 text-[13px] font-medium text-fg-muted hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <FolderPlusIcon className="size-4 text-fg-muted" />
            New section
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="transparent"
            size="medium"
            onClick={() =>
              customize.apply(resolveSidebar(EMPTY_SIDEBAR, consoles), "Restored the default sidebar.", true)
            }
          >
            <RotateCcwIcon className="size-3.5" />
            Restore default sidebar
          </Button>
          <span className="text-[11.5px] text-fg-subtle">Saved as you go. Every device sees the same sidebar.</span>
        </div>
        <Button variant="accent" size="medium" onClick={customize.done}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** A hidden page or console. Click to put it back; or drag it to a place. */
function Tile({
  id,
  label,
  icon,
  console,
  title,
  onClick,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  console: boolean;
  title: string;
  onClick: () => void;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `tile:${id}`,
    data: { kind: "tile", id } satisfies RailDrag,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      title={title}
      onClick={onClick}
      className={cn(
        "group flex h-[34px] cursor-grab touch-pan-y select-none [-webkit-touch-callout:none] items-center gap-2 rounded-lg border border-line-strong bg-surface pr-3 pl-2.5 text-[13px] font-medium text-fg hover:border-accent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        isDragging && "opacity-35",
      )}
    >
      <span className="size-4 shrink-0 text-fg-muted group-hover:text-accent">{icon ?? <PlusIcon className="size-4" />}</span>
      {label}
      {console && <span className="text-[12px] font-normal text-fg-subtle">console</span>}
    </button>
  );
}
