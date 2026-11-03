// What a press of a command (POST /api/cues/:name) answered, and what to tell
// the operator about it.

import { errorMessage } from "@main/services/errors";
import { invoke } from "./api";

export interface CallAnswer {
  status: number;
  ok?: boolean;
  detail?: string;
  error?: string;
  reason?: string;
  skipped?: boolean;
  /** Automation is in Simulate mode: the cue was accepted and nothing reached a device. */
  simulated?: boolean;
}

/**
 * What to tell the operator about a command's answer, or null when it reached a
 * device. Shared by every surface that presses a command (a Button, a Home tile),
 * so a refusal, a Simulate and a failed dispatch read the same everywhere.
 */
export function callAnswerNote(r: CallAnswer): string | null {
  if (r.status === 200) {
    if (r.skipped) return r.detail ?? "Already there";
    // Said, not silent: a press that reached no device must not look like one
    // that did.
    if (r.simulated) return "Simulated: nothing was sent";
    if (r.ok === false) return r.detail ?? "Failed";
    return null;
  }
  if (r.status === 202) return "Needs confirmation; use the rules page";
  return r.error ?? r.detail ?? "Refused";
}

/**
 * Press a command and return what to tell the operator, or null when it reached
 * a device. Never throws: a request that failed outright is returned as a note
 * too, so the three surfaces that press a command (a Button, a Home tile, an
 * attention fix) say a refusal, a Simulate and an unanswered press the same way.
 *
 * `call` is the seam a test replaces; production posts the cue.
 */
export async function pressCommand(
  name: string,
  call: (name: string) => Promise<CallAnswer> = (n) => invoke<CallAnswer>("cues:call", { name: n }),
): Promise<string | null> {
  try {
    return callAnswerNote(await call(name));
  } catch (e) {
    return `Could not reach the server: ${errorMessage(e)}`;
  }
}
