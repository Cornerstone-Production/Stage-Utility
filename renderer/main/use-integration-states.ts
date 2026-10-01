import { useCallback, useMemo, useState } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/** Stable identity, so a hook with nothing yet does not hand a new array out per render. */
const NO_STATES: IntegrationState[] = [];
const NO_LABELS: Record<string, string> = {};

/**
 * The set of integration ids the operator has set up (creds/config saved, or the
 * master toggle for wireless/OSC). Hydrates from `integrations:list` on mount and
 * stays live via the `integrations:state-changed` channel.
 *
 * Keyed on the server's `configured` flag, NOT the live connection — so the
 * layout-editor palette can tell "not set up" (dim + "set up X") apart from "set
 * up but currently disconnected" (stays available).
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job — see
 * the note there. The read is mapped to the push's shape in the thunk: the two
 * halves of this channel are `{ states }` and a bare `IntegrationState[]`, and
 * one of them has to give.
 */
export function useConfiguredIntegrations(): Set<string> {
  const read = useCallback(
    () => invoke<{ states: IntegrationState[] }>("integrations:list").then((r) => r?.states ?? NO_STATES),
    [],
  );
  const { value: states } = useStatusChannel<IntegrationState[]>(read, "integrations:state-changed");
  return useMemo(
    () => new Set((states ?? NO_STATES).filter((s) => s.configured).map((s) => s.id)),
    [states],
  );
}

export interface IntegrationsSnapshot {
  /** Live per-integration state (id, enabled, connection, message, config). */
  states: IntegrationState[];
  /** Friendly descriptor label keyed by integration id (for display). */
  labels: Record<string, string>;
  /** Whether ANY answer has landed yet — see useStatusChannel's own header.
   *  `states` is `NO_STATES` (empty) both before the first answer and once
   *  genuinely configured with nothing enabled; the context bar's
   *  "integration-health" item must not read the first of those as "no
   *  integrations" before this is true. */
  known: boolean;
}

/**
 * Full integration snapshot — live `connection` state plus the friendly label
 * for each integration. Backs the "Integration status" layout object, its
 * editor picker and the context bar's health item. Hydrates from
 * `integrations:list`, stays live via `integrations:state-changed`.
 *
 * Ordering is useStatusChannel's, as above. The labels are lifted out of the same
 * read rather than fetched again, which is why they are set from inside the
 * thunk: they are DESCRIPTOR metadata, fixed for a server run and carried by no
 * broadcast, so they are correct even in the case the hook exists for — the one
 * where the read's `states` are dropped as older than a push already applied.
 *
 * @param enabled false where nothing on screen draws it — a layout with no
 *   integration-status object. Off, it neither reads nor subscribes.
 */
export function useIntegrations(enabled = true): IntegrationsSnapshot {
  const [labels, setLabels] = useState<Record<string, string>>(NO_LABELS);
  const read = useCallback(
    () =>
      invoke<{ descriptors: { id: string; label: string }[]; states: IntegrationState[] }>(
        "integrations:list",
      ).then((r) => {
        const next: Record<string, string> = {};
        for (const d of r?.descriptors ?? []) next[d.id] = d.label;
        setLabels(next);
        return r?.states ?? NO_STATES;
      }),
    [],
  );
  const { value: states, known } = useStatusChannel<IntegrationState[]>(read, "integrations:state-changed", enabled);
  return useMemo(() => ({ states: states ?? NO_STATES, labels, known }), [states, labels, known]);
}
