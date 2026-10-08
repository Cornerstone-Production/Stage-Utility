// report-action-failure.ts — what a stage-message control does when the server
// refuses or cannot be reached: tell the operator, and put it on /log.
//
// Both, always, in the same words. A send, a reply or a clear that did not go must
// not read as done (the toast), and an operator debugging on Sunday morning reads
// /log, not the browser's console (the line).

import { errorMessage } from "@main/services/errors";
import { toast } from "../components/ui";
import { logToServer } from "../lib/client-log";

/**
 * `what` finishes "Could not ..." ("send that reply"); `detail` says which one in
 * the log line only ("to 3f2a...").
 */
export function reportActionFailure(what: string, err: unknown, detail?: string): void {
  const why = errorMessage(err);
  toast.error(`Could not ${what}: ${why}`);
  logToServer("messages", `could not ${what}${detail ? ` (${detail})` : ""}: ${why}`);
}
