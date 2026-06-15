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

  return { state, isLoading, error };
}
