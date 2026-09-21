// The clock for a component that holds no server-stamped timestamp of its own.
//
// Every surface that already has one — anything holding a `pcoLive`, a PVP
// status — feeds renderer/lib/server-clock.ts from it and reads the corrected
// instant back with `useServerClock`. This is for the rest: it subscribes to
// `pco:live` for itself, feeds the same one clock, and returns the same one
// number. `pco:live` is a hydrated channel, so a late subscriber is handed the
// connect-time frame in a microtask rather than waiting for the next push.

import { useEffect } from "react";

import { onNotification } from "../lib/api";
import { serverClock, useServerNow } from "../lib/server-clock";

/**
 * The current instant, on the server's clock.
 *
 * @param intervalMs how often the returned value advances. Pick the coarsest
 *   cadence the caller can live with: it is a re-render each time.
 * @param enabled false where the caller was handed a corrected clock already and
 *   only calls this because a hook cannot be conditional, or where whatever it
 *   counts is not running. Off, it neither ticks nor subscribes, so the surface
 *   that has its own clock pays nothing for a second one.
 */
export function useCorrectedNow(intervalMs: number, enabled = true): number {
  useEffect(() => {
    if (!enabled) return;
    return onNotification("pco:live", (payload: unknown, replayed: boolean) => {
      // A replay is this client's own cache being handed to a late subscriber,
      // so its `serverNow` says when the frame was FIRST seen and reading a
      // clock offset from it would be reading an old one. The best-of window in
      // ServerClock would reject it beside a fresher sample, but on a cold page
      // it can be the only sample there is.
      if (replayed) return;
      const serverNow = (payload as { serverNow?: string } | null)?.serverNow;
      if (!serverNow) return;
      const measured = Date.parse(serverNow);
      if (!Number.isFinite(measured)) return;
      serverClock.observe(measured);
    });
  }, [enabled]);

  return useServerNow(intervalMs, enabled);
}
