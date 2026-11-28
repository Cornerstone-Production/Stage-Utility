// report-failure.ts — what a control does when a write the operator asked for
// did not land: tell them, and put it on /log.
//
// Both, always. A toast is gone in four seconds and a console line reaches
// nobody (see client-log.ts), while an operator debugging on Sunday morning
// reads /log. A failure that only did the first is a blank page the next day.
//
// The ONE reporter: a control that has its own wording keeps its toast and calls
// logFailure beside it; one that says "Could not ..." calls reportFailure.
//
// `what` and `detail` carry ids and key names, never a token, secret or address.

import { errorMessage } from "@main/services/errors";
import { toast } from "../components/ui";
import { logToServer } from "./client-log";

/** One line on /log: "could not {what} ({detail}): {why}". `what` finishes
 *  "could not ..." ("send that reply"); `detail` says which one, on the line only. */
export function logFailure(tag: string, what: string, err: unknown, detail?: string): void {
  logToServer(tag, `could not ${what}${detail ? ` (${detail})` : ""}: ${errorMessage(err)}`);
}

/** The toast "Could not {what}: {why}" and the log line, in the same words. */
export function reportFailure(tag: string, what: string, err: unknown, detail?: string): void {
  toast.error(`Could not ${what}: ${errorMessage(err)}`);
  logFailure(tag, what, err, detail);
}
