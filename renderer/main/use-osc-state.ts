import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/** Stable identity, so a hook with nothing yet does not hand a new array out per render. */
const NO_TARGETS: OscTarget[] = [];

/**
 * Live OSC feedback, pushed on the "osc:feedback" channel. Hydrates once on mount
 * (the channel only broadcasts on change) then stays live. Read by osc-button
 * objects to reflect device state. Values are keyed "targetId::address" (with a
 * "*::address" wildcard fallback).
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job — see
 * the note there. It matters here as much as anywhere: a button whose read landed
 * after the push shows the wrong lamp until somebody touches the desk again.
 */
export function useOscState(enabled = true): OscFeedbackDTO | null {
  const read = useCallback(() => invoke<OscFeedbackDTO>("osc:getFeedback"), []);
  return useStatusChannel<OscFeedbackDTO>(read, "osc:feedback", enabled);
}

/** The configured OSC targets, kept live via the "osc:targets-changed" channel.
 *  Used by the layout editor's OSC-button inspector (target picker). */
export function useOscTargets(): OscTarget[] {
  const read = useCallback(() => invoke<OscTarget[]>("osc:listTargets"), []);
  return useStatusChannel<OscTarget[]>(read, "osc:targets-changed") ?? NO_TARGETS;
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
