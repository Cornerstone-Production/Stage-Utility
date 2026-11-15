// What follows the pointer while a row, a heading or a tray tile is dragged.
//
// A small pill rather than a copy of the row: the row stays where it was, faded,
// and the caret says where it will land. Red-edged while releasing would hide it.

import type { ReactNode } from "react";
import { GripVerticalIcon } from "lucide-react";

import type { ResolvedSidebar } from "@main/services/sidebar-arrangement";
import { cn } from "../lib/cn";
import type { RailDrag } from "./rail-drop";

export function RailDragGhost({
  drag,
  out,
  describe,
  resolved,
}: {
  drag: RailDrag;
  out: boolean;
  describe: (id: string) => { label: string; icon: ReactNode } | null;
  resolved: ResolvedSidebar;
}) {
  let icon: ReactNode = <GripVerticalIcon className="size-3.5" />;
  let label: string;
  if (drag.kind === "head") {
    label = `${resolved.sections.find((s) => s.id === drag.id)?.label ?? ""} section`;
  } else {
    const d = describe(drag.id);
    icon = d?.icon ?? icon;
    label = d?.label ?? drag.id;
  }
  return (
    <div
      className={cn(
        "pointer-events-none inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] border bg-popover px-2.5 py-[5px] text-[12.5px] font-medium text-fg shadow-xl",
        out ? "border-danger-9 [&_svg]:text-danger-11" : "border-accent [&_svg]:text-accent",
      )}
    >
      <span className="grid size-3.5 place-items-center [&_svg]:size-3.5">{icon}</span>
      {label}
    </div>
  );
}
