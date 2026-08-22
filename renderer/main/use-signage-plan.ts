// use-signage-plan.ts — this screen's slice of the signage horizon.
//
// The server pushes a map of outputId to a 24-hour horizon on `signage:plan`,
// broadcast only when it CHANGES. A display picks its own entry off its own
// clock, which is what lets the server stay quiet between config edits rather
// than talking at every boundary.
//
// The rule about advancing only while connected lands in the task that adds it;
// for now this selects the entry the clock points at.

import { useEffect, useState } from "react";
import type { SignageHorizon, SignageHorizonEntry } from "@main/types/signage";

import { onNotification } from "../lib/api";
import { entryAt } from "./signage-cycle";

export function useSignagePlan(
  outputId: string,
  /** The surface's clock. Passed in rather than read here: the surface already
   *  ticks one for the player, and a second Date.now() is both impure during
   *  render and a way for the two to disagree about what time it is. */
  nowMs: number,
): {
  entry: SignageHorizonEntry | null;
  horizon: SignageHorizon;
} {
  const [horizon, setHorizon] = useState<SignageHorizon>([]);

  useEffect(() => {
    // The channel is hydrated on connect (see the hello burst), so a screen that
    // loads mid-window gets its horizon immediately rather than waiting for the
    // next change — which on a quiet Tuesday could be hours.
    return onNotification("signage:plan", (payload: unknown) => {
      const map = payload as Record<string, SignageHorizon> | null;
      setHorizon(map?.[outputId] ?? []);
    });
  }, [outputId]);

  return { entry: entryAt(horizon, nowMs), horizon };
}
