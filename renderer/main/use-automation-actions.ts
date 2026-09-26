// The automation action registry's id/label pairs, for the action-button
// object: resolving `actionId` to a human label when its own `label` is
// blank, and saying when a stored id no longer exists.
//
// A shared react-query cache, not a private one-shot fetch: a panel of several
// action-buttons each mount this hook, and a private fetch per mount meant a
// three-button panel fired three identical GET /api/automation/registry
// requests. The one shared definition in lib/automation-registry.ts, which
// the inspector and the automation section use too, so every ActionButton on
// screen (and either editor surface, if ever open at the same time) settles
// from one request, in one shape.
//
// `refetchOnWindowFocus` is off: a kiosk display sits on a wall, not in a
// browser tab an operator switches back to, so that signal means nothing here.
// `retry` is NOT overridden, so the QueryClient's own setting applies: the
// displays' client (renderer/main/router.tsx) keeps react-query's default of
// 3 with backoff, which is where a button has to recover on its own; the
// operator app's client turns retry off app-wide, and its editor canvas shows
// the failure at once instead. It used to be forced off here, on the theory that the
// registry never changes at runtime so a failure "will not resolve itself" —
// true of the DATA, false of the READ: a console panel loading while the
// server is still coming up (a Pi at boot, or the 15 s request timeout under
// load) fails once and would succeed on the very next attempt. `retry: false`
// left every button on that panel dimmed for as long as the page stayed up,
// since nothing re-mounts this observer to try again. automationRegistryQuery
// already logs once per failed FETCH, not once total, so the few extra
// attempts a real outage produces do not flood /log.

import { useQuery } from "@tanstack/react-query";

import { automationRegistryQuery } from "../lib/automation-registry";
import type { ParamDef } from "@main/types/automation";

export interface AutomationActionSpec {
  id: string;
  label: string;
  /** Was already on the wire (GET /api/automation/registry sends every
   *  action's full params) — this just gives it a type. The action-button
   *  object's canvas tile needs it to know whether its own config still needs
   *  setup; see action-button.tsx. */
  params: ParamDef[];
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

/** Never throws out of the hook: a failure is returned in `error`, logged to
 *  the server (not only the browser console — see client-log.ts) once per
 *  failed fetch, and the caller decides what to show. Swallowing it here is
 *  exactly the shape this repo's "a new catch either rethrows or returns the
 *  failure" rule exists to catch: an unreachable server used to leave every
 *  action-button on screen reading a bare id with nothing saying why. */
export function useAutomationActions(): AutomationActionsState {
  const { data, isError } = useQuery({
    ...automationRegistryQuery,
    refetchOnWindowFocus: false,
    select: (registry): AutomationActionSpec[] => registry.actions,
  });
  return { actions: data ?? null, error: isError };
}
