// The ServiceCue text size a DISPLAY draws, kept by the server.
//
// A display's size used to live in that device's localStorage, so a Screens
// preview of it — running in the operator's browser — never saw it, and replacing
// the device lost it. It is Output.textSize now, carried to every client in
// `resolvedByOutput`, and this hook is the display's two duties around it: draw
// the kept size, and offer one to keep when it has one the server does not
// (displayTextSize says which).
//
//   - `?text=<percent>` on the display's address is kept on the server. Once
//     kept, the address stops counting: the server's value is the display's, and
//     a size changed some other way is not overwritten by a stale link.
//   - A display the server holds no size for, with one remembered by this device
//     (under its current or its pre-rename key), keeps that once.
//
// A failed save is logged on /log and not retried in a loop; the display draws
// the size it was given until the next load. A preview never saves.

import { errorMessage } from "@main/services/errors";
import { useEffect, useState } from "react";

import { invoke } from "../lib/api";
import { logToServer } from "../lib/client-log";
import { displayTextSize, displayTextSizeKey, readStoredSize, textSizeFromSearch } from "./servicecue-text-size";

export function useDisplayTextSize(displayId: string, server: number | null, isPreview: boolean): number {
  // Read once, at mount: the address a display was opened with is the intent, and
  // a device's remembered size is only an offer for a server that has none.
  const [fromAddress] = useState(() => (isPreview ? null : textSizeFromSearch(window.location.search)));
  const [remembered] = useState(() => (isPreview ? null : readStoredSize(displayTextSizeKey(displayId))));
  // Set once the server holds the address's size: from then on the address is spent.
  const [addressKept, setAddressKept] = useState(false);

  // Adjusted during render rather than in an effect: the render that first sees
  // the server holding the address's size is already the one that stops reading it.
  if (!addressKept && fromAddress !== null && server === fromAddress) setAddressKept(true);

  const plan = displayTextSize({ isPreview, fromAddress: addressKept ? null : fromAddress, server, remembered });

  useEffect(() => {
    if (plan.save === null) return;
    const size = plan.save;
    // Success needs no handling here: the server's broadcast carries the size back
    // as `server`, which is what spends the address (above). Waiting for it, rather
    // than for this reply, is what keeps the display on the size it is showing
    // while the two cross.
    invoke("outputs:setTextSize", { id: displayId, textSize: size }).catch((err: unknown) =>
      logToServer("servicecue", `could not keep this display's text size of ${size}%: ${errorMessage(err)}`),
    );
  }, [plan.save, displayId]);

  return plan.show;
}
