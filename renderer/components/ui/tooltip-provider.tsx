import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

/**
 * Wraps the app so `<Tooltip>` works anywhere inside it.
 *
 * The delay is shorter than the browser's own ~1s on a `title`, which is long
 * enough that operators assume nothing is there. Once one tooltip has opened,
 * moving along a row of icon buttons shows the rest immediately — the delay
 * exists to stop tooltips flickering up while the pointer crosses the screen,
 * not to make a deliberate scan feel slow.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={400}>
      {children}
    </TooltipPrimitive.Provider>
  );
}
