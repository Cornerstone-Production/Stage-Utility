// The one clock a component is allowed to ask what time it is.
//
// This app has ONE clock: the server's, corrected against by every surface that
// shows a time. A wall Pi is the reason — an isolated production LAN runs no NTP,
// so a display that has been on the wall for a year can be minutes or hours out,
// and a component reading `Date.now()` reports the drift as fact.
//
// The correction is the same one seven surfaces already make: `pco:live` carries
// `serverNow`, and the difference between it and the browser's clock is the skew.
// Those seven hold a `pcoLive` already — they take it from useDashboardState for
// other reasons — and derive `now` and `skewMs` as two separate values because
// their consumers (LayoutRenderCtx among them) hand the pair on. This hook is for
// a component that has neither: it subscribes for itself and returns the one
// number. `pco:live` is a hydrated channel, so a late subscriber is handed the
// connect-time frame in a microtask rather than waiting for the next push.

import { useEffect, useState } from "react";

import { onNotification } from "../lib/api";

/**
 * The current instant, corrected against the server's clock.
 *
 * @param intervalMs how often the returned value advances. Pick the coarsest
 *   cadence the caller can live with: it is a re-render each time.
 * @param enabled false where the caller was handed a corrected clock already and
 *   only calls this because a hook cannot be conditional. Off, it neither ticks
 *   nor subscribes, so the surface that has its own clock pays nothing for a
 *   second one.
 */
export function useCorrectedNow(intervalMs: number, enabled = true): number {
  const [skewMs, setSkewMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    return onNotification("pco:live", (payload: unknown) => {
      const serverNow = (payload as { serverNow?: string } | null)?.serverNow;
      if (!serverNow) return;
      const measured = Date.parse(serverNow);
      if (!Number.isFinite(measured)) return;
      // Whole seconds only. `serverNow` moves on every push — as often as once a
      // second while a service is live — and a skew stored to the millisecond
      // would re-render the caller at that rate however coarse its own tick is.
      // Returning the previous value is a React bail-out, so a settled clock
      // costs nothing after the first frame, and a real correction still lands on
      // the frame it arrives in rather than at the next tick.
      const next = measured - Date.now();
      setSkewMs((prev) => (Math.abs(next - prev) >= 1000 ? next : prev));
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);

  return now + skewMs;
}
