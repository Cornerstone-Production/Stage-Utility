// The automation action registry's id/label pairs, for the action-button
// object: resolving `actionId` to a human label when its own `label` is
// blank, and saying when a stored id no longer exists.
//
// A plain one-shot fetch, not useStatusChannel: the registry has no live push
// channel (it changes only when the app itself changes, never at runtime), so
// there is nothing to subscribe to — unlike obs:status or cue-live, which
// hydrate once and then stay live.

import { useEffect, useState } from "react";

import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { logToServer } from "../lib/client-log";

export interface AutomationActionSpec {
  id: string;
  label: string;
}

export interface AutomationActionsState {
  /** Every action id the registry currently answers for, or null before the
   *  first read completes OR once a read has failed — the two are told apart
   *  by `error` below, since a caller must not treat "cannot say yet" and
   *  "genuinely does not exist" as the same thing. */
  actions: AutomationActionSpec[] | null;
  /** True once a read has failed (network or a malformed answer). The list
   *  itself could not be loaded, so no actionId can be called known OR
   *  unknown — a caller must say THAT, not fall back to guessing. */
  error: boolean;
}

/** Never throws: a failure is returned in `error`, logged to the server (not
 *  only the browser console — see client-log.ts), and the caller decides what
 *  to show. Swallowing it here is exactly the shape this repo's "a new catch
 *  either rethrows or returns the failure" rule exists to catch: an
 *  unreachable server used to leave every action-button on screen reading a
 *  bare id with nothing saying why. */
export function useAutomationActions(): AutomationActionsState {
  const [state, setState] = useState<AutomationActionsState>({ actions: null, error: false });
  useEffect(() => {
    let cancelled = false;
    void invoke<{ actions?: AutomationActionSpec[] }>("automation:registry")
      .then((r) => {
        if (cancelled) return;
        if (!Array.isArray(r?.actions)) throw new Error("answered with no actions array");
        setState({ actions: r.actions, error: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logToServer("action-button", `could not load the automation registry: ${errorMessage(err)}`);
        setState({ actions: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
