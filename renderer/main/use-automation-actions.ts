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
// from one request, in one shape. `retry` and
// `refetchOnWindowFocus` are off to match the one-shot semantics this hook
// always had — the registry has no live push channel (it changes only when
// the app itself changes, never at runtime), so retrying it, or re-reading it
// every time an operator's browser tab regains focus, only adds noise around
// a failure that will not resolve itself.

import { useQuery } from "@tanstack/react-query";

import { automationRegistryQuery } from "../lib/automation-registry";

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

/** Never throws out of the hook: a failure is returned in `error`, logged to
 *  the server (not only the browser console — see client-log.ts) once per
 *  failed fetch, and the caller decides what to show. Swallowing it here is
 *  exactly the shape this repo's "a new catch either rethrows or returns the
 *  failure" rule exists to catch: an unreachable server used to leave every
 *  action-button on screen reading a bare id with nothing saying why. */
export function useAutomationActions(): AutomationActionsState {
  const { data, isError } = useQuery({
    ...automationRegistryQuery,
    retry: false,
    refetchOnWindowFocus: false,
    select: (registry): AutomationActionSpec[] => registry.actions,
  });
  return { actions: data ?? null, error: isError };
}
