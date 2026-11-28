// use-dismiss.ts — how the Q-SYS popovers (the sidebar row's flyout, a panel's
// cog menu) get out of the way.
//
// Not the app's ContextMenu: that is a right-click menu, and the approved
// navigation and panel mockups draw something it cannot without becoming a
// different component (a 260 px card with 42 px rows, the panel's kind on the
// right and the current one lit in the accent, opened by a hover timer across a
// bridge; a 320 px card of 52 px rows with a PIN pad inside). What both share with
// it is the dismissal, and that lives here once:
//
//   - Escape, on `window` in the capture phase, and stopped there. Radix's dialog
//     and the phone-width sidebar drawer listen on `document`, which a window
//     capture listener runs before, so the one Escape closes the popover and not
//     also the drawer or dialog under it.
//   - A pointerdown outside every element in `inside` (the trigger and the card,
//     which a portal may have put anywhere in the document).
//   - Optionally, the window resizing or anything scrolling, for a popover placed
//     at fixed coordinates that would otherwise hang where the row used to be.

import { useEffect, type RefObject } from "react";

import { useLatestRef } from "../../lib/use-latest-ref";

export type DismissedBy = "escape" | "outside" | "moved";

export function useDismiss(
  open: boolean,
  onDismiss: (by: DismissedBy) => void,
  { inside = [], moves = false }: { inside?: readonly RefObject<HTMLElement | null>[]; moves?: boolean } = {},
): void {
  const dismiss = useLatestRef(onDismiss);
  const within = useLatestRef(inside);
  useEffect(() => {
    if (!open) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      dismiss.current("escape");
    };
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && within.current.some((r) => r.current?.contains(t))) return;
      dismiss.current("outside");
    };
    const moved = () => dismiss.current("moved");
    window.addEventListener("keydown", escape, true);
    if (within.current.length > 0) document.addEventListener("pointerdown", outside, true);
    if (moves) {
      window.addEventListener("resize", moved);
      // Capture: a scroll does not bubble, and the sidebar is the element that scrolls.
      document.addEventListener("scroll", moved, true);
    }
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", moved);
      document.removeEventListener("scroll", moved, true);
    };
  }, [open, moves, dismiss, within]);
}
