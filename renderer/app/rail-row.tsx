// One page or console row in the sidebar, with its own context menu.

import type { ReactNode } from "react";
import { SidebarListItem } from "../components/ui/sidebar";
import { ContextMenu, type ContextMenuItem } from "../components/ui/context-menu";
import { useContextMenuState, useContextMenuTrigger } from "../components/ui/context-menu-trigger";
import type { Destination } from "./destinations";

/** What a row that opens a list instead of navigating is given: its own click, keys
 *  and active state (Q-SYS, see qsys-rail-row.tsx). */
export interface RowExtras {
  isActive: boolean;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  "aria-expanded": boolean;
  "aria-controls"?: string;
  children: ReactNode;
}

/**
 * One page or console in the sidebar, with its own right-click and long-press
 * menu.
 *
 * Its own trigger, on the ROW: the row is a <button>, and a trigger on the rail
 * around it treats a press on a control inside as that control's own (see
 * context-menu-trigger.ts), so the rail's menu would never open from a row on a
 * phone. A console's glyph keeps its own menu for the icon: a press there is
 * left to it.
 */
export function RailRow({
  d,
  badge,
  ariaLabel,
  menuItems,
  extras,
}: {
  d: Destination;
  badge?: ReactNode;
  ariaLabel?: string;
  menuItems: () => ContextMenuItem[];
  /** A row that does something other than navigate (Q-SYS opens a list): its own
   *  click, keys and active state, and no destination to select. */
  extras?: RowExtras;
}) {
  const { menu, open, close } = useContextMenuState();
  const trigger = useContextMenuTrigger((point) => open(point, menuItems()));
  return (
    <>
      <SidebarListItem
        item={extras ? undefined : d}
        icon={d.icon}
        title={d.label}
        ariaLabel={ariaLabel}
        badge={badge}
        // The row's trigger claims the press or right-click, so the rail around it
        // does not open its own menu as well; a console's glyph claims it first, so
        // its icon menu is the only one that opens there.
        onContextMenu={trigger.onContextMenu}
        onPointerDown={trigger.onPointerDown}
        onPointerMove={trigger.onPointerMove}
        onPointerUp={trigger.onPointerUp}
        onPointerCancel={trigger.onPointerCancel}
        onClickCapture={trigger.onClickCapture}
        style={trigger.style}
        {...extras}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />}
    </>
  );
}

