// use-signage-plan.ts — this screen's slice of the signage horizon.
//
// The server pushes a map of outputId to a 24-hour horizon on `signage:plan`,
// broadcast only when it CHANGES. A display picks its own entry off its own
// clock, which is what lets the server stay quiet between config edits rather
// than talking at every boundary.
//
// The rule that makes this worth doing lives in signage-hold.ts: at a boundary a
// display advances only while it is connected. Everything here is plumbing for
// that — the horizon, the connection state, and the one piece of state the rule
// needs (what this screen was last actually showing).

import { useEffect, useState } from "react";
import type { SignageHorizon, SignageHorizonEntry } from "@main/types/signage";

import { onNotification, onSseConnection } from "../lib/api";
import { pickEntry } from "./signage-hold";

/**
 * Is this the same horizon this screen already has?
 *
 * PURE and exported so it can be checked without a DOM. Structural, not by
 * reference: every broadcast arrives as fresh JSON, so a reference check would
 * always say "changed".
 *
 * It matters because the horizon array keys an effect that writes the whole plan
 * to the device and re-fetches every asset. The server broadcasts on a change to
 * ANY screen, so a screen whose own slice did not change still receives it — and
 * on a Pi, acting on that is SD-card writes for nothing.
 */
export function sameHorizon(a: SignageHorizon, b: SignageHorizon): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function useSignagePlan(
  outputId: string,
  /** The surface's clock. Passed in rather than read here: the surface already
   *  ticks one for the player, and a second Date.now() is both impure during
   *  render and a way for the two to disagree about what time it is. */
  nowMs: number,
): {
  entry: SignageHorizonEntry | null;
  horizon: SignageHorizon;
  connected: boolean;
} {
  const [horizon, setHorizon] = useState<SignageHorizon>([]);

  /**
   * When the event stream went down, or null while it is up.
   *
   * This single number IS the offline rule: pickEntry reads the horizon at this
   * instant instead of now, so a disconnected display's clock stops and it never
   * reaches the next boundary. Set from the connection callback, which is an
   * event rather than a render, so there is no ref to read and no state to
   * synchronise on a tick.
   */
  const [disconnectedAtMs, setDisconnectedAtMs] = useState<number | null>(null);

  useEffect(() => {
    // The channel is hydrated on connect (see the hello burst), so a screen that
    // loads mid-window gets its horizon immediately rather than waiting for the
    // next change — which on a quiet Tuesday could be hours.
    return onNotification("signage:plan", (payload: unknown) => {
      const map = payload as Record<string, SignageHorizon> | null;
      const next = map?.[outputId] ?? [];
      // The SAME array back when this screen's own slice did not change — see
      // sameHorizon for why that identity matters.
      setHorizon((prev) => (sameHorizon(prev, next) ? prev : next));
    });
  }, [outputId]);

  useEffect(
    () =>
      onSseConnection((up) => {
        // Date.now() at the moment of the drop, which is more accurate than
        // anything a render could observe: the display may be between ticks.
        setDisconnectedAtMs(up ? null : Date.now());
      }),
    [],
  );

  return {
    entry: pickEntry({ horizon, nowMs, disconnectedAtMs }),
    horizon,
    connected: disconnectedAtMs === null,
  };
}
