// Whether the Screens page's side panel is open, remembered per browser.
//
// A preference of the person at this browser, not a setting of the install: one
// operator keeping the panel docked and another hiding it should not fight over a
// server value. Reads and writes are wrapped because storage is not always there
// (private browsing, a locked-down kiosk) and a preference that cannot be kept
// must not stop the page from drawing.

import { useState } from "react";

export const PANEL_OPEN_KEY = "stage-utility-screens-panel";

/** Open unless the operator said otherwise. With nothing stored, a viewport too
 *  narrow to dock the panel beside the cards starts with it closed: there it is
 *  an overlay, and one open on arrival would cover the page. */
function initial(): boolean {
  try {
    const stored = localStorage.getItem(PANEL_OPEN_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 1024px)").matches;
}

export function usePanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(initial);
  function setOpen(next: boolean) {
    setOpenState(next);
    try {
      localStorage.setItem(PANEL_OPEN_KEY, next ? "1" : "0");
    } catch {
      // Not kept; the panel still opens and closes for this visit.
    }
  }
  return [open, setOpen];
}
