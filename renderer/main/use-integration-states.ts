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
