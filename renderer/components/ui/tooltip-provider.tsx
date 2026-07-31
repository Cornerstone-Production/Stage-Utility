import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

/**
 * Wraps the app so `<Tooltip>` works anywhere inside it.
 *
 * The delay is deliberately long. These label controls that are already legible
 * from their icon and position, so a tooltip is for the rare moment someone is
 * unsure — not something to fire at every pointer that crosses a toolbar. Two
 * seconds reads as a deliberate hover without being long enough that the tooltip
 * seems not to exist.
 *
 * `skipDelayDuration` of 0 means every tooltip waits its full turn: there is no
 * window where moving to the next control opens instantly. That grouping makes
 * sense for a short delay and works against a long one, since the whole point
 * here is that a tooltip should take asking for.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={2000} skipDelayDuration={0}>
      {children}
    </TooltipPrimitive.Provider>
  );
}
