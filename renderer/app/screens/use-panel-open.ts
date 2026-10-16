// Whether the Screens page's side panel is open, remembered per browser.
//
// A preference of the person at this browser, not a setting of the install: one
// operator keeping the panel docked and another hiding it should not fight over a
// server value. Reads and writes are wrapped because storage is not always there
// (private browsing, a locked-down kiosk) and a preference that cannot be kept
// must not stop the page from drawing.

import { useState } from "react";
import { readStored, writeStored } from "../../lib/safe-storage";

export const PANEL_OPEN_KEY = "stage-utility-screens-panel";

/** Open unless the operator said otherwise. With nothing stored, a viewport too
 *  narrow to dock the panel beside the cards starts with it closed: there it is
 *  an overlay, and one open on arrival would cover the page. */
function initial(): boolean {
  // Storage unavailable reads as nothing stored: fall through to the default.
  const stored = readStored(PANEL_OPEN_KEY, (raw) => raw, null);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 1024px)").matches;
}

export function usePanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(initial);
  function setOpen(next: boolean) {
    setOpenState(next);
    // Not kept when storage refuses; the panel still opens and closes for this visit.
    writeStored(PANEL_OPEN_KEY, next ? "1" : "0");
  }
  return [open, setOpen];
}
