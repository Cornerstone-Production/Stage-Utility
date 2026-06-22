import { useState, useEffect } from "react";
import { invoke, onNotification } from "../lib/api";

interface UseStageStateResult {
  state: StageState | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hydrate the full StageState from the backend and keep it live.
 *
 * Fetches once on mount via `stage:getState`, then subscribes to
 * `stage:state-changed` broadcasts for real-time updates. Shared by the kiosk
 * StageView and the display-picker landing page so both stay in sync.
 */
export function useStageState(): UseStageStateResult {
  const [state, setState] = useState<StageState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Hydrate on mount.
  useEffect(() => {
    let cancelled = false;
    invoke<StageState>("stage:getState")
      .then((s: StageState) => {
        if (!cancelled) setState(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.error("[useStageState] hydrate error", err);
          setError(String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to live updates.
  useEffect(() => {
    return onNotification("stage:state-changed", (payload: unknown) => {
      setState(payload as StageState);
    });
  }, []);

  // Auto-reload after an update: the server sends "server:hello" with its code
  // version on every (re)connect. The browser's EventSource auto-reconnects when
  // the server restarts (install.sh or the in-app updater), so a display that
  // reconnects to a *newer* version reloads itself to pick up the new assets — no
  // manual refresh needed. A plain crash-restart keeps the same version (no
  // reload). Skipped for the settings preview iframe.
  useEffect(() => {
    const path = window.location.pathname;
    // Only the kiosk display screens self-reload after an update. The settings
    // UI is an operator console (and hosts live-preview iframes that are each a
    // full app instance) — reloading it on every server restart is disruptive
    // and makes those iframes stampede the just-restarted server. The preview
    // iframes themselves never reload either.
    if (path.startsWith("/preview-") || path.startsWith("/settings")) return;
    let seen: string | null = null;
    let reloading = false;
    return onNotification("server:hello", (payload: unknown) => {
      const version = (payload as { version?: string } | null)?.version ?? null;
      if (!version || version === "unknown") return;
      if (seen === null) {
        seen = version;
      } else if (version !== seen && !reloading) {
        reloading = true;
        // Small random delay so a wall of displays doesn't reload in lockstep
        // and hammer the server the instant it comes back up.
        setTimeout(() => window.location.reload(), 250 + Math.random() * 1000);
      }
    });
  }, []);

  return { state, isLoading, error };
}
