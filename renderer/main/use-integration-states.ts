import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * The set of integration ids the operator has set up (creds/config saved, or the
 * master toggle for wireless/OSC). Hydrates from `integrations:list` on mount and
 * stays live via the `integrations:state-changed` channel.
 *
 * Keyed on the server's `configured` flag, NOT the live connection — so the
 * layout-editor palette can tell "not set up" (dim + "set up X") apart from "set
 * up but currently disconnected" (stays available).
 */
export function useConfiguredIntegrations(): Set<string> {
  const [configured, setConfigured] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const apply = (states: IntegrationState[] | undefined) => {
      if (cancelled || !states) return;
      setConfigured(new Set(states.filter((s) => s.configured).map((s) => s.id)));
    };
    invoke<{ states: IntegrationState[] }>("integrations:list")
      .then((r) => apply(r?.states))
      .catch(() => {
        /* not reachable yet — leave empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onNotification("integrations:state-changed", (p) => {
      const states = p as IntegrationState[];
      setConfigured(new Set(states.filter((s) => s.configured).map((s) => s.id)));
    });
  }, []);

  return configured;
}

export interface IntegrationsSnapshot {
  /** Live per-integration state (id, enabled, connection, message, config). */
  states: IntegrationState[];
  /** Friendly descriptor label keyed by integration id (for display). */
  labels: Record<string, string>;
}

/**
 * Full integration snapshot — live `connection` state plus the friendly label
 * for each integration. Backs the "Integration status" layout object and its
 * editor picker. Hydrates from `integrations:list`, stays live via
 * `integrations:state-changed`.
 */
export function useIntegrations(): IntegrationsSnapshot {
  const [snap, setSnap] = useState<IntegrationsSnapshot>(() => ({ states: [], labels: {} }));

  useEffect(() => {
    let cancelled = false;
    invoke<{ descriptors: { id: string; label: string }[]; states: IntegrationState[] }>("integrations:list")
      .then((r) => {
        if (cancelled || !r) return;
        const labels: Record<string, string> = {};
        for (const d of r.descriptors ?? []) labels[d.id] = d.label;
        setSnap({ states: r.states ?? [], labels });
      })
      .catch(() => {
        /* not reachable yet */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onNotification("integrations:state-changed", (p) => {
      setSnap((prev) => ({ ...prev, states: p as IntegrationState[] }));
    });
  }, []);

  return snap;
}
