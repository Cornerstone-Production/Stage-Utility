// What follows the pointer while a sidebar row, a heading, a tray tile or a
// context-bar reading is dragged.
//
// A small pill rather than a copy of the row: the row stays where it was, faded,
// and the caret says where it will land. Red-edged while releasing would hide it.

import type { ReactNode } from "react";
import { GripVerticalIcon, LockIcon } from "lucide-react";

import type { ResolvedSidebar } from "@main/services/sidebar-arrangement";
import { cn } from "../lib/cn";
import type { RailDrag } from "./rail-drop";
import { presentation } from "./bar-editor";
import type { BarRowId } from "./bar-items";

export function RailDragGhost({
  drag,
  out,
  blocked = false,
  describe,
  resolved,
}: {
  drag: RailDrag;
  out: boolean;
  /** Let go here, the row would be hidden, and this one cannot be. */
  blocked?: boolean;
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
  // Advanced dragged off the sidebar says, before it is let go, that it stays.
  if (blocked) return <DragGhost icon={<LockIcon className="size-3.5" />} label={`${label} stays in the sidebar`} out={false} muted />;
  return <DragGhost icon={icon} label={label} out={out} />;
}

/** The pill itself, for a rail row, a heading, or a context-bar reading. `out`
 *  is the remove state (danger border and icon); `muted` is "this does nothing". */
export function DragGhost({ icon, label, out, muted = false }: { icon: ReactNode; label: string; out: boolean; muted?: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none inline-flex w-max items-center gap-1.5 whitespace-nowrap rounded-[7px] border bg-popover px-2.5 py-[5px] text-[12.5px] font-medium text-fg shadow-xl",
        out
          ? "border-danger-9 [&_svg]:text-danger-11"
          : muted
            ? "border-line-strong text-fg-muted [&_svg]:text-fg-muted"
            : "border-accent [&_svg]:text-accent",
      )}
    >
      <span className="grid size-3.5 place-items-center [&_svg]:size-3.5">{icon}</span>
      {label}
    </div>
  );
}

/** A context-bar reading or gap being dragged; red when letting go removes it. */
export function BarDragGhost({ id, out }: { id: BarRowId; out: boolean }) {
  const { icon: Icon, label } = presentation(id);
  return <DragGhost icon={<Icon className="size-3.5" />} label={label} out={out} />;
}
