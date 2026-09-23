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

export interface AutomationActionSpec {
  id: string;
  label: string;
}

/** Every action id the automation registry currently answers for, or null
 *  before the first read completes. Never throws: an unreachable server (or a
 *  build too old to answer) leaves this null, which callers treat as "cannot
 *  say yet" rather than "does not exist". */
export function useAutomationActions(): AutomationActionSpec[] | null {
  const [actions, setActions] = useState<AutomationActionSpec[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void invoke<{ actions?: AutomationActionSpec[] }>("automation:registry")
      .then((r) => {
        if (!cancelled && Array.isArray(r?.actions)) setActions(r.actions);
      })
      .catch(() => {
        // Left null — "cannot say yet", not "unknown action". A read that
        // failed must not make every action-button on screen claim its
        // action is gone.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return actions;
}
