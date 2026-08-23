// rotation-menu.tsx — how a panel is hung, as a submenu.
//
// ONE copy. It was written out twice, verbatim down to the labels, in the main
// screen card and in the signage screen row — and so were the two menu class
// constants beside it. Four quarter turns, because a panel is hung one of four
// ways and an arbitrary angle is a mis-typed number that leaves a wall crooked.
//
// The rotation is a fact about the PANEL, not about what is playing on it, which
// is why it lives on the screen rather than on a view.

import { DropdownMenu } from "radix-ui";
import { CheckIcon, RotateCwIcon } from "lucide-react";

import type { ScreenRotation } from "@main/types/views";

/** The menu surface and its rows. Shared so two menus on the same page cannot
 *  drift into looking like two different menus. */
export const MENU_CONTENT =
  "z-50 min-w-44 rounded-lg border border-line bg-popover p-1 shadow-lg";
export const MENU_ITEM =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-footnote " +
  "text-fg outline-none data-[highlighted]:bg-fill-active";

const TURNS = [0, 90, 180, 270] as const;

function label(deg: ScreenRotation): string {
  return deg === 0 ? "Normal" : deg === 180 ? "Upside down" : `${deg}° clockwise`;
}

export function RotationMenu({
  rotation,
  onSet,
}: {
  rotation: ScreenRotation;
  onSet: (deg: ScreenRotation) => void;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={MENU_ITEM}>
        <RotateCwIcon className="size-3.5 text-fg-subtle" />
        Rotation
        <span className="ml-auto text-caption2 text-fg-subtle">
          {rotation === 0 ? "Normal" : `${rotation}°`}
        </span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className={MENU_CONTENT} sideOffset={2}>
          {TURNS.map((deg) => (
            <DropdownMenu.Item key={deg} onSelect={() => onSet(deg)} className={MENU_ITEM}>
              <CheckIcon
                className={rotation === deg ? "size-3.5 text-accent" : "size-3.5 opacity-0"}
              />
              {label(deg)}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
