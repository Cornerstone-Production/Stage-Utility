// The subscriptions and side effects that must outlive any single route.
//
// These were `useEffect`s in settings-view.tsx, which was mounted for as long as
// the settings window was open. Under routing there is no such component: if
// this wiring lived on a route, navigating away would unsubscribe it and the app
// would stop seeing live changes until you happened to return. So the Shell
// mounts it once, above the Outlet.
//
// Everything here writes into the React Query cache under the keys in
// queries.ts. Those keys are the originals for exactly this reason.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onNotification } from "../lib/api";
import { applyDeviceTelemetry } from "../lib/apply-device-telemetry";
import { applyAccentVar } from "../lib/apply-accent";
import { QUERY_KEYS } from "./queries";
import {
  clearUpdatePending,
  finishUpdateAndReload,
  noteServerVersion,
  pendingUpdate,
} from "./update-lifecycle";

/**
 * Mount once, in the Shell.
 *
 * @param accentColor The branding accent to apply to the document root.
 */
export function useStageLiveWiring(accentColor: string | null | undefined): void {
  const queryClient = useQueryClient();

  // The themeable brand accent, injected as a CSS variable. Without this a
  // church's chosen colour silently stops applying — the app still works, so
  // nothing reports it.
  useEffect(() => {
    applyAccentVar(accentColor);
  }, [accentColor]);

  // Live state changes from the backend, plus device telemetry.
  useEffect(() => {
    const unsub = onNotification("stage:state-changed", (payload: unknown) => {
      queryClient.setQueryData(QUERY_KEYS.stageState, payload as StageState);
    });
    // Telemetry rides its own channel so a meter twitch does not re-send the
    // whole state document; merge it back so the slots editor's RF bars stay
    // live.
    const unsubDevices = onNotification("slots:devices", (payload: unknown) => {
      queryClient.setQueryData(QUERY_KEYS.stageState, (prev: StageState | undefined) =>
        prev ? applyDeviceTelemetry(prev, payload as Record<string, SlotDevice>) : prev,
      );
    });
    return () => {
      unsub();
      unsubDevices();
    };
  }, [queryClient]);

  // Update completion, the durable path. This channel re-hydrates on every SSE
  // (re)connect, so the post-restart reconnect delivers the finished state even
  // if the server:hello below was missed.
  useEffect(() => {
    return onNotification("update:status", (payload: unknown) => {
      const status = payload as UpdateStatus;
      queryClient.setQueryData(QUERY_KEYS.updateStatus, status);
      if (!pendingUpdate() || status.phase === "updating") return;
      if (status.error) {
        // Failed apply — the server stayed on the old build. Clear the flag and
        // let the panel show the error rather than reloading onto nothing new.
        clearUpdatePending();
      } else {
        finishUpdateAndReload(status.version ?? null);
      }
    });
  }, [queryClient]);

  // Update completion, the fast path: a server:hello whose version differs from
  // the one captured when Update was pressed means the new build is live.
  useEffect(() => {
    return onNotification("server:hello", (payload: unknown) => {
      const version = (payload as { version?: string } | null)?.version ?? null;
      if (!version || version === "unknown") return;
      noteServerVersion(version);
      const pending = pendingUpdate();
      if (pending && version !== pending.fromVersion) finishUpdateAndReload(version);
    });
  }, []);

  // When Planning Center connects, refetch what depends on it. Without this,
  // connecting PCO leaves the service-type and plan lists stale — the operator
  // has just configured it and the dropdowns still say nothing is there.
  useEffect(() => {
    return onNotification("integrations:state-changed", (payload: unknown) => {
      const states = payload as IntegrationState[];
      const pco = states.find((s) => s.id === "planning-center");
      if (pco?.connection !== "connected") return;
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.serviceTypes });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stageState });
      // No service type in the key: prefix matching clears every variant.
      queryClient.invalidateQueries({ queryKey: ["stage:listPlans"] });
    });
  }, [queryClient]);
}
