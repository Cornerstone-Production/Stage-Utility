import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Live OSC feedback, pushed on the "osc:feedback" channel. Hydrates once on mount
 * (the channel only broadcasts on change) then stays live. Read by osc-button
 * objects to reflect device state. Values are keyed "targetId::address" (with a
 * "*::address" wildcard fallback).
 */
export function useOscState(): OscFeedbackDTO | null {
  const [osc, setOsc] = useState<OscFeedbackDTO | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<OscFeedbackDTO>("osc:getFeedback")
      .then((s) => {
        if (!cancelled && s) setOsc(s);
      })
      .catch(() => {
        /* not configured yet — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onNotification("osc:feedback", (p) => setOsc(p as OscFeedbackDTO));
  }, []);

  return osc;
}

/** The configured OSC targets, kept live via the "osc:targets-changed" channel.
 *  Used by the layout editor's OSC-button inspector (target picker). */
export function useOscTargets(): OscTarget[] {
  const [targets, setTargets] = useState<OscTarget[]>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<OscTarget[]>("osc:listTargets")
      .then((t) => {
        if (!cancelled && t) setTargets(t);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onNotification("osc:targets-changed", (p) => setTargets(p as OscTarget[]));
  }, []);

  return targets;
}

/** Resolve a button's feedback "active" state from the latest values. */
export function resolveOscActive(
  osc: OscFeedbackDTO | null,
  targetId: string | null | undefined,
  bind: OscFeedbackBind | null | undefined,
): boolean {
  if (!osc || !bind?.address) return false;
  const direct = targetId ? osc.values[`${targetId}::${bind.address}`] : undefined;
  const value = direct !== undefined ? direct : osc.values[`*::${bind.address}`];
  if (value === undefined) return false;
  if (bind.equals === undefined) return Boolean(value) && value !== 0;
  // Loose compare so "1" from a string-typed reply still matches a numeric 1.
  return String(value) === String(bind.equals);
}
