import { useState, useEffect } from "react";
import { invoke, onNotification } from "../lib/api";
import { applyDeviceTelemetry } from "../lib/apply-device-telemetry";
import { applyAccentVar } from "../lib/apply-accent";
import { setDisplayHourCycle } from "../lib/clock-format";

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
        if (!cancelled) {
          // Before the first render that could show a clock. Set HERE because
          // every surface — operator app and stage display alike — hydrates
          // through this hook, so there is exactly one place to keep in sync.
          setDisplayHourCycle(s.hourCycle);
          setState(s);
        }
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
      const next = payload as StageState;
      // Kept in step with the state that carries it, so a toggle in Advanced
      // reaches every open surface on the same broadcast that re-renders them.
      setDisplayHourCycle(next.hourCycle);
      setState(next);
    });
  }, []);

  // Volatile per-slot telemetry (RF, battery, audio level) arrives on its own
  // channel so a meter twitch does not re-send the whole state document. Merged
  // back onto the slots here, where every component already looks for it.
  useEffect(() => {
    return onNotification("slots:devices", (payload: unknown) => {
      setState((prev) =>
        prev ? applyDeviceTelemetry(prev, payload as Record<string, SlotDevice>) : prev,
      );
    });
  }, []);

  // Auto-reload after an update — including for an installed Home-Screen PWA.
  // The server stamps the version the page was built at into the served HTML
  // (window.__APP_VERSION__) and reports the live version over SSE ("server:hello")
  // and at /api/version. If a page's stamped version differs from the live one it
  // is running a stale (cached) shell, so it reloads to pull the new assets — no
  // manual refresh, no re-adding to the Home Screen. Re-checked on foreground so a
  // PWA opened after a deploy self-heals on relaunch. Falls back to detecting a
  // change while open for pre-stamp shells (which have no __APP_VERSION__).
  useEffect(() => {
    const path = window.location.pathname;
    // The settings console (+ its live-preview iframes) must not reload out from
    // under an operator mid-edit; only the display / volunteer surfaces self-reload.
    if (path.startsWith("/preview-") || path.startsWith("/settings")) return;
    const own = (window as unknown as { __APP_VERSION__?: string }).__APP_VERSION__ ?? null;
    let reloading = false;
    let seen: string | null = null;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      // Small random delay so a wall of displays doesn't reload in lockstep.
      setTimeout(() => window.location.reload(), 250 + Math.random() * 1000);
    };
    const check = (v: string | null) => {
      if (!v || v === "unknown") return;
      if (own) {
        if (v !== own) reload();
      } else if (seen === null) {
        seen = v;
      } else if (v !== seen) {
        reload();
      }
    };
    const off = onNotification("server:hello", (payload: unknown) => check((payload as { version?: string } | null)?.version ?? null));
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !own) return;
      fetch("/api/version")
        .then((r) => r.json())
        .then((d: { version?: string }) => check(d?.version ?? null))
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Push the themeable brand accent into --brand-accent whenever it changes.
  //
  // ONLY ONCE HYDRATED. `--brand-accent` is one variable on the document root and
  // seventeen components call this hook, each with its own `state`. Every one of
  // them starts null, and calling applyAccentVar(undefined) REMOVES the override
  // -- so any component mounting mid-session tore the accent off the whole page
  // until its own fetch came back, and everything on the accent snapped to the
  // CSS default and back. Opening a colour picker did exactly that: the panel's
  // saved-colours list calls this hook, so the click that opened it flashed every
  // accent-coloured thing on the page.
  //
  // A null accent from a HYDRATED state still clears it -- that is the operator
  // choosing no brand colour, and it has to be honoured. What must not clear it
  // is an instance that simply has not loaded yet.
  //
  // Measured both ways on one build, Screens page, one click on an icon:
  //   without this line  --brand-accent went "#3b82f6" -> (REMOVED), and every
  //                      icon on the accent flashed #3b82f6 -> #2e6691 (the CSS
  //                      default) and back
  //   with it            the variable never moves and no icon changes at all
  useEffect(() => {
    if (!state) return;
    applyAccentVar(state.accentColor);
  }, [state, state?.accentColor]);

  return { state, isLoading, error };
}
