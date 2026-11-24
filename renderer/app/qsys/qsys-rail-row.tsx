// The Q-SYS row in the sidebar: a flyout on hover, a folder on tap.
//
//   hover (a mouse, 500 ms)  a flyout to the right of the rail listing every panel,
//                            its kind on the right, and "All panels and Q-SYS
//                            settings" last. Items light up under the pointer; the
//                            current panel stays lit.
//   tap / Enter / Space      the row opens in place like a folder, because touch
//                            has no hover. The folder lists the same items.
//   keyboard                 ArrowRight (or ArrowDown) on the row opens the flyout
//                            and moves into it; arrows move, Escape or ArrowLeft
//                            closes it and returns to the row.
//
// The flyout is drawn in a portal at fixed coordinates: the sidebar scrolls and
// clips, and a flyout inside it would be cut off at the rail's edge. A portal's
// React parent is still this component, so moving the pointer from the row into
// the flyout is not a leave. Between them sits a transparent bridge, part of the
// flyout, so crossing the gap does not close it. Neither the clipping nor the
// bridge exists in jsdom, which loads no stylesheet and measures every box as 0:
// qsys-rail-row.test.tsx pins the timing, the state and the keys, and the
// geometry was driven in a browser.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon } from "lucide-react";
import type { View } from "@main/types/views";
import { SidebarChromeProvider, useSidebarChrome } from "../../components/ui/sidebar";
import { cn } from "../../lib/cn";
import type { ContextMenuItem } from "../../components/ui/context-menu";
import type { Destination } from "../destinations";
import { RailRow } from "../rail-row";
import { QSYS_MANAGE_PATH, qsysManagePanelPath, qsysManagedSlugOf } from "./qsys-paths";

/** How long the pointer rests on the row before the flyout opens. */
export const QSYS_FLYOUT_DELAY_MS = 500;
/** The flyout's width, and how far it stands clear of the row (the bridge fills it). */
const FLYOUT_WIDTH = 260;
const BRIDGE = 28;
const MANAGE_LABEL = "All panels and Q-SYS settings";

interface Props {
  /** Every Q-SYS panel, in view order. */
  panels: readonly View[];
  pathname: string;
  /** The rail is the icon-only one: a row cannot open in place there. */
  railed: boolean;
  /** The row's destination and its context menu: it is drawn as every other row is. */
  d: Destination;
  menuItems: () => ContextMenuItem[];
  onNavigate: (to: string) => void;
}

export function QsysRailRow({ panels, pathname, railed, d, menuItems, onNavigate }: Props) {
  const chrome = useSidebarChrome();
  const [flyout, setFlyout] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const flyoutEl = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFirst = useRef(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  const currentSlug = qsysManagedSlugOf(pathname);
  const onManage = pathname === QSYS_MANAGE_PATH || pathname === `${QSYS_MANAGE_PATH}/`;
  const inQsys = currentSlug !== null || onManage;
  // A folder opens in place only in the full-width rail; the icon rail has no room.
  const folderOpen = expanded && !railed;

  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancelTimer, []);
  const close = (refocus = false) => {
    cancelTimer();
    setFlyout(false);
    if (refocus) wrapper.current?.querySelector("button")?.focus();
  };

  // Where the flyout goes: against the row's right edge, its top level with the row,
  // and kept inside the window. Measured when it opens, before it paints.
  useLayoutEffect(() => {
    if (!flyout || !wrapper.current) return;
    const row = wrapper.current.getBoundingClientRect();
    const height = flyoutEl.current?.offsetHeight ?? 0;
    const top = Math.max(8, Math.min(row.top - 8, window.innerHeight - height - 8));
    setPlace({ left: row.right, top });
  }, [flyout, panels.length]);

  // Out of the way when the window moves under it or something else is pressed.
  useEffect(() => {
    if (!flyout) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (wrapper.current?.contains(t) || flyoutEl.current?.contains(t))) return;
      setFlyout(false);
    };
    const away = () => setFlyout(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", away);
    };
  }, [flyout]);

  // Keyboard entry: the flyout has drawn, so there is an item to focus.
  useEffect(() => {
    if (!flyout || !place || !focusFirst.current) return;
    focusFirst.current = false;
    flyoutEl.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [flyout, place]);

  const go = (to: string) => {
    close();
    onNavigate(to);
    chrome.closeDrawer?.();
  };

  const items = panels.map((p) => ({
    key: p.id,
    label: p.name,
    kind: p.qsys!.kind,
    to: qsysManagePanelPath(p.qsys!.slug),
    current: p.qsys!.slug === currentSlug,
  }));

  function onRowKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      cancelTimer();
      focusFirst.current = true;
      if (flyout) flyoutEl.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
      else setFlyout(true);
    } else if (e.key === "Escape" && flyout) {
      e.stopPropagation();
      close();
    }
  }

  function onFlyoutKeyDown(e: React.KeyboardEvent) {
    const buttons = [...(flyoutEl.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      buttons[(to + buttons.length) % buttons.length]?.focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(buttons.length - 1);
    else if (e.key === "Escape" || e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  }

  const hoverIn = (e: React.PointerEvent) => {
    // A touch makes an emulated hover on the way to its tap; the tap opens the folder.
    if (e.pointerType !== "mouse" || flyout || folderOpen) return;
    cancelTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      setFlyout(true);
    }, QSYS_FLYOUT_DELAY_MS);
  };
  const hoverOut = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    close();
  };

  const toggle = () => {
    cancelTimer();
    if (railed) setFlyout((o) => !o);
    else {
      setFlyout(false);
      setExpanded((o) => !o);
    }
  };

  // The flyout's panel names are foreground, its last item muted; the folder's rows are
  // muted with the current one on a neutral fill (the approved mockup).
  const itemCls = (on: boolean, where: "flyout" | "folder", muted = where === "folder") =>
    cn(
      "flex w-full items-center gap-2 rounded-lg px-2.5 text-left text-footnote outline-none transition-colors duration-(--motion-instant)",
      "min-h-9 coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-accent",
      where === "flyout" && (on ? "bg-accent/20 font-semibold text-fg ring-1 ring-inset ring-accent/45" : cn(muted ? "text-fg-muted" : "text-fg", "hover:bg-fill-active hover:text-fg")),
      where === "folder" && (on ? "bg-fill-active font-medium text-fg" : "text-fg-muted hover:bg-fill hover:text-fg"),
    );

  return (
    // The mobile drawer's close-on-select belongs to a row that navigates; this one opens a list.
    <SidebarChromeProvider value={{ collapsed: chrome.collapsed, isMobile: chrome.isMobile }}>
      <div ref={wrapper} onPointerEnter={hoverIn} onPointerLeave={hoverOut} onContextMenuCapture={() => close()} data-qsys-rail-row>
        <RailRow
          d={d}
          menuItems={menuItems}
          extras={{
            isActive: inQsys,
            onClick: toggle,
            onKeyDown: onRowKeyDown,
            "aria-expanded": folderOpen || flyout,
            "aria-controls": folderOpen ? "qsys-folder" : undefined,
            children: (
              <ChevronRightIcon
                aria-hidden
                className={cn("ml-auto size-3.5 shrink-0 text-fg-subtle transition-transform duration-(--motion-instant)", folderOpen && "rotate-90", railed && "sr-only")}
              />
            ),
          }}
        />
        {folderOpen && (
          <div id="qsys-folder" className="ml-[17px] flex flex-col gap-0.5 border-l border-line py-0.5 pl-[18px]" data-qsys-folder>
            {items.map((i) => (
              <button
                key={i.key}
                type="button"
                aria-current={i.current ? "page" : undefined}
                onClick={() => go(i.to)}
                className={itemCls(i.current, "folder")}
              >
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
              </button>
            ))}
            <button
              type="button"
              aria-current={onManage ? "page" : undefined}
              onClick={() => go(QSYS_MANAGE_PATH)}
              className={itemCls(onManage, "folder")}
            >
              {MANAGE_LABEL}
            </button>
          </div>
        )}
        {flyout &&
          createPortal(
            // The padding is the bridge: transparent, part of the flyout, so the
            // pointer is still over it while it crosses from the row to the card.
            <div
              ref={flyoutEl}
              role="menu"
              aria-label="Q-SYS panels"
              data-qsys-flyout
              onKeyDown={onFlyoutKeyDown}
              className="fixed z-[90]"
              style={{ left: place?.left ?? 0, top: place?.top ?? 0, paddingLeft: BRIDGE, visibility: place ? "visible" : "hidden" }}
            >
              <div
                className="flex flex-col gap-0.5 rounded-[14px] border border-line-strong bg-popover p-1.5 shadow-2xl"
                style={{ width: FLYOUT_WIDTH }}
              >
                {items.map((i) => (
                  <button
                    key={i.key}
                    type="button"
                    role="menuitem"
                    aria-current={i.current ? "page" : undefined}
                    onClick={() => go(i.to)}
                    className={cn(itemCls(i.current, "flyout"), "h-[42px]")}
                  >
                    <span className="min-w-0 flex-1 truncate">{i.label}</span>
                    <span className="text-caption1 font-normal text-fg-subtle">{i.kind}</span>
                  </button>
                ))}
                <div className="mx-1 my-1.5 h-px bg-line" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  aria-current={onManage ? "page" : undefined}
                  onClick={() => go(QSYS_MANAGE_PATH)}
                  className={cn(itemCls(onManage, "flyout", true), "h-10")}
                >
                  {MANAGE_LABEL}
                </button>
              </div>
            </div>,
            document.body,
          )}
      </div>
    </SidebarChromeProvider>
  );
}
