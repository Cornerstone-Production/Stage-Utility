// app-state-reads.ts — what each `app:` state source currently says.
//
// The registry itself is pure and lives in app-state-sources.ts, because the
// rule editor imports it through cue-pairs.ts. This half touches the services
// and is server-only.
//
// One reader per source, in a Record over the id union: a source added to
// APP_STATE_SOURCE_IDS without a reader here does not compile. A Map with an
// optional lookup would instead have shipped a source that reads unknown
// forever, which is exactly the silent failure the binding exists to remove.
//
// A reader NEVER throws and never guesses: "REAPER is not connected" is the
// honest answer for an integration that is off or unreachable, and it reaches
// the operator as the cue state's `reason`.

import {
  APP_STATE_SOURCES,
  appStateSourceId,
  type AppStateSourceId,
} from "./app-state-sources.js";
import type { VariableResult } from "./companion-api.js";
import { reaperService } from "./reaper-service.js";

/** A source's answer: a value, or why nobody can say. */
export interface AppStateValue {
  value: string | null;
  /** Present exactly when `value` is null. */
  reason?: string;
}

const REAPER = APP_STATE_SOURCES.get("reaper.recording")!;

const READS: Record<AppStateSourceId, () => AppStateValue> = {
  "reaper.recording": () => {
    const status = reaperService.getLatest();
    // NOT "off" for a REAPER nobody can reach. An unreachable recorder reporting
    // "not recording" is a Home Assistant switch saying the service is not being
    // recorded when the truth is that we do not know.
    if (!status.connected) return { value: null, reason: "REAPER is not connected" };
    return { value: status.recording ? REAPER.onValue : REAPER.offValue };
  },
};

/**
 * Read one `app:` ref, in the same shape `companionApi.readVariable` answers in
 * — so cue-states.ts treats both namespaces identically from there on.
 */
export function readAppState(variable: string): VariableResult {
  const id = appStateSourceId(variable);
  if (!id) return { error: `no Stage Utility state source called "${variable.trim()}"` };
  const answer = READS[id]();
  return answer.value === null ? { error: answer.reason ?? "cannot be read" } : { value: answer.value };
}
