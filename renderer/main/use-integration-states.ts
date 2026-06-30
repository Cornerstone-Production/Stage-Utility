import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * The set of integration ids that are currently ENABLED (i.e. the operator has
 * set them up). Hydrates from `integrations:list` on mount and stays live via
 * the `integrations:state-changed` channel.
 *
 * This reflects "configured", NOT live connection — so consumers (e.g. the
 * layout editor's add-object palette) never treat an object as unavailable just
 * because its integration momentarily disconnects.
 */
export function useEnabledIntegrations(): Set<string> {
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const apply = (states: IntegrationState[] | undefined) => {
      if (cancelled || !states) return;
      setEnabled(new Set(states.filter((s) => s.enabled).map((s) => s.id)));
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
      setEnabled(new Set(states.filter((s) => s.enabled).map((s) => s.id)));
    });
  }, []);

  return enabled;
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
