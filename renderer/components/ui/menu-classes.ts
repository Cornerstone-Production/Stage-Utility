// Dropdown/context-menu classes, in one place.
//
// These were a file-local pair in outputs-section plus four hand-written copies
// of the full item string in layout-editor -- and, inside outputs-section itself,
// one menu item that spelled the danger variant out by hand while another two
// hundred lines away composed it correctly from the constant. Six spellings of
// two rules.

import { cn } from "../../lib/cn";

/** One row in a menu. */
export const MENU_ITEM =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote text-fg outline-none data-[highlighted]:bg-fill";

/**
 * A destructive row — remove, delete, unbind.
 *
 * Includes the disabled treatment, which the hand-written copy carried and the
 * composed one did not: a destructive action that cannot be taken has to look
 * unavailable, not merely fail to respond.
 */
export const MENU_ITEM_DANGER = cn(
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-footnote outline-none",
  "text-red-11 data-[highlighted]:bg-red-3",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
);

/**
 * The panel the rows sit in.
 *
 * `minWidth` because the two callers genuinely differ — the screens menu is 48
 * and the editor's template menu is 52, which is a real difference rather than
 * drift, so it is a parameter instead of a second constant.
 */
export function menuContent(minWidth: "min-w-48" | "min-w-52" = "min-w-48"): string {
  return cn(
    "z-50 rounded-md border border-line-strong bg-popover p-1 shadow-md backdrop-blur-xl",
    minWidth,
  );
}
