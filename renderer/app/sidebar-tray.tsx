// The tray Customize mode docks under the page: one tab for the sidebar and one
// for the context bar, each with what can be put back or added, and the mode's
// own controls. Switching tabs keeps the mode open, so each part is edited where
// it sits.
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

import { createElement, useEffect, useState, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { FolderPlusIcon, MonitorIcon, MoveHorizontalIcon, PanelLeftCloseIcon, PlusIcon, RotateCcwIcon, SmartphoneIcon } from "lucide-react";

import { EMPTY_SIDEBAR, homeSectionIn, isConsoleId, resolveSidebar } from "@main/services/sidebar-arrangement";
import { Button, SegmentedSwitch, type SegmentedOption } from "../components/ui";
import { useSidebarCollapsed } from "../lib/use-sidebar-collapsed";
import { cn } from "../lib/cn";
import { useCustomize, type CustomizeTab } from "./customize-mode";
import { ALL_BAR_IDS, NarrowProbe, narrowWarning, presentation, type BarDrag, type BarEditor } from "./bar-editor";
import { BAR_SPACE, BAR_SPACER, isBarGap } from "./bar-items";
import { useBarContext } from "./bar-strip";
import { DRAGGABLE } from "./drag-parts";
import type { BarSet } from "./set-bar-items";
import type { RailDrag } from "./rail-drop";
import { restorePage } from "./sidebar-edits";

export function CustomizeTray({
  isMobile,
  barOnPage = true,
}: {
  isMobile: boolean;
  /** This page draws the context bar. A console run without the app's chrome
   *  does not, so there is nothing for the Context bar tab to edit on it. */
  barOnPage?: boolean;
}) {
  const customize = useCustomize();
  const { trayRef, aim } = customize;
  // The bar tab, on a page with no bar: it says so and offers nothing.
  const bar = barOnPage ? customize.bar : null;
  const barTabWithoutBar = customize.tab === "bar" && !barOnPage;
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
        <SegmentedSwitch label="What to customize" options={TABS} value={customize.tab} onChange={customize.setTab} />
        {bar && <SegmentedSwitch label="Which bar" options={SETS} value={bar.editing} onChange={bar.setEditing} />}
      </div>
      {barTabWithoutBar ? (
        <p className="m-0 text-[12px] leading-4 text-fg-muted">
          This page has no context bar. Open Customize from a page that has one.
        </p>
      ) : bar ? (
        <BarTrayBody bar={bar} />
      ) : (
        <SidebarTrayBody isMobile={isMobile} collapsed={collapsed} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <div className="flex flex-wrap items-center gap-1">
          {bar ? <BarTrayActions bar={bar} /> : !barTabWithoutBar && <SidebarTrayActions />}
        </div>
        <Button variant="accent" size="medium" onClick={customize.done}>
          Done
        </Button>
      </div>
    </div>
  );
}

function SidebarTrayActions() {
  const customize = useCustomize();
  return (
    <>
      <Button
        variant="transparent"
        size="medium"
        onClick={() => customize.apply(() => resolveSidebar(EMPTY_SIDEBAR, customize.consoles), "Restored the default sidebar.", true)}
      >
        <RotateCcwIcon className="size-3.5" />
        Restore default sidebar
      </Button>
      <span className="text-[11.5px] text-fg-subtle">Saved as you go. Every device sees the same sidebar.</span>
    </>
  );
}

function BarTrayActions({ bar }: { bar: BarEditor }) {
  return (
    <>
      <Button variant="transparent" size="medium" onClick={bar.useDefault}>
        <RotateCcwIcon className="size-3.5" />
        Use the default set
      </Button>
      {bar.editing === "mobile" && !bar.inheriting && (
        <Button variant="transparent" size="medium" onClick={bar.followDesktop}>
          Follow the desktop bar
        </Button>
      )}
      <span className="text-[11.5px] text-fg-subtle">Saved as you go. Every device sees the same bar.</span>
    </>
  );
}

const TABS: readonly SegmentedOption<CustomizeTab>[] = [
  { id: "sidebar", label: "Sidebar", Icon: PanelLeftCloseIcon },
  { id: "bar", label: "Context bar", Icon: MoveHorizontalIcon },
];

const SETS: readonly SegmentedOption<BarSet>[] = [
  { id: "desktop", label: "Desktop", Icon: MonitorIcon },
  { id: "mobile", label: "Phone", Icon: SmartphoneIcon },
];

/** The sidebar tab: what is not in the sidebar, to put back. */
function SidebarTrayBody({ isMobile, collapsed }: { isMobile: boolean; collapsed: boolean }) {
  const customize = useCustomize();
  const { resolved, describe } = customize;
  const pages = resolved.hiddenPages;
  const hiddenConsoles = resolved.hiddenConsoles;

  function restore(id: string) {
    if (isConsoleId(id)) customize.setConsoleShown(id, true);
    else customize.apply((r) => restorePage(r, id));
  }

  return (
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
      {pages.length === 0 && hiddenConsoles.length === 0 ? (
        <div className="py-1.5 text-[12.5px] text-fg-subtle">Every page is in the sidebar. Drag one out to hide it.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {[...pages, ...hiddenConsoles].map((id) => {
            const d = describe(id);
            const home = isConsoleId(id) ? "Consoles" : homeSectionIn(resolved.sections, id).label || "the top";
            return (
              <TrayTile
                key={id}
                drag={{ kind: "tile", id } satisfies RailDrag}
                label={d?.label ?? id}
                icon={d?.icon}
                note={isConsoleId(id) ? "console" : undefined}
                title={`Back to ${home}`}
                onClick={() => restore(id)}
              />
            );
          })}
        </div>
      )}
      <div className="mt-0.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => customize.addSection()}
          className="flex h-[34px] items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface pr-3 pl-2.5 text-[13px] font-medium text-fg-muted hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <FolderPlusIcon className="size-4 text-fg-muted" />
          New section
        </button>
      </div>
    </div>
  );
}

/** The context bar tab: every reading, and the two kinds of gap. */
function BarTrayBody({ bar }: { bar: BarEditor }) {
  const ctx = useBarContext();
  const [narrow, setNarrow] = useState<{ over: number; cut: string[] }>({ over: 0, cut: [] });
  const warning = bar.shownOnPhone ? narrowWarning(narrow) : null;
  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
      {bar.inheriting && (
        <div className="rounded-lg bg-fill px-2.5 py-2 text-[12px] leading-4 text-fg-muted">
          The phone is showing the desktop bar. Change anything here and it gets a set of its own; until then the two stay together.
        </div>
      )}
      <p className="m-0 text-[12px] leading-4 text-fg-muted">
        Drag items into the bar, along it to reorder, and out of it to remove. Click a tile to add it at the end.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {[...ALL_BAR_IDS, BAR_SPACE, BAR_SPACER].map((id) => {
          const item = presentation(id);
          // Neither gap is ever "used up": the whole point of both is being able
          // to place more than one.
          const used = !isBarGap(id) && bar.used.has(id);
          return (
            <TrayTile
              key={id}
              drag={{ kind: "bar-tile", id } satisfies BarDrag}
              label={item.label}
              icon={createElement(item.icon, { className: "size-4" })}
              title={item.hint}
              used={used}
              ariaLabel={used ? `${item.label}: already in the bar` : `Add ${item.label}`}
              onClick={() => bar.add(id)}
            />
          );
        })}
      </div>
      {/* WHAT HAPPENS AT THE NARROWEST WIDTH, measured rather than guessed: see
          NarrowProbe. Only the bad news, and ONLY FOR A SET A PHONE ACTUALLY
          RENDERS: a desktop set the phone has stopped following is never laid
          out at 320 px, so there is nothing true to say about it there. */}
      {bar.shownOnPhone && <NarrowProbe rows={bar.rows.map((r) => r.id)} ctx={ctx} onFit={setNarrow} />}
      {warning && <p className="m-0 text-[12px] leading-4 text-warn-11">{warning}</p>}
    </div>
  );
}

/**
 * A tile in the tray: a hidden page or console, or a reading for the bar. Click
 * it to put it back or add it; or drag it to a place. The same tile on both tabs.
 */
function TrayTile({
  drag,
  label,
  icon,
  note,
  title,
  used = false,
  ariaLabel,
  onClick,
}: {
  drag: RailDrag | BarDrag;
  label: string;
  icon: ReactNode;
  note?: string;
  title: string;
  /** Already in the bar: dimmed and not draggable, as macOS does it. */
  used?: boolean;
  ariaLabel?: string;
  onClick: () => void;
}) {
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `${drag.kind}:${"id" in drag ? drag.id : ""}`,
    data: drag,
    disabled: used,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      title={title}
      // Click is the accessible path to the same thing: adding must not require
      // a drag.
      onClick={used ? undefined : onClick}
      // aria-disabled, NOT disabled. A disabled button computes
      // `pointer-events: none`, which makes it a hole the pointer falls through,
      // and a drag released over a hole has nothing to release onto. It also
      // keeps the tile focusable, so a keyboard user can read why.
      aria-disabled={used || undefined}
      aria-label={ariaLabel}
      className={cn(
        DRAGGABLE,
        "group flex h-[34px] items-center gap-2 rounded-lg border border-line-strong bg-surface pr-3 pl-2.5 text-[13px] font-medium text-fg",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        used ? "cursor-default opacity-40" : "hover:border-accent",
        isDragging && "opacity-35",
      )}
    >
      <span className={cn("size-4 shrink-0 text-fg-muted", !used && "group-hover:text-accent")}>{icon ?? <PlusIcon className="size-4" />}</span>
      {label}
      {note && <span className="text-[12px] font-normal text-fg-subtle">{note}</span>}
    </button>
  );
}
