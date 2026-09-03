import { useState } from "react";

import { useResyncOn } from "./use-resync-on";

/**
 * How far this browser's clock is behind the server's, measured only when
 * `serverNow` CHANGES after mount — never at mount itself.
 *
 * The mount-time value is a replayed snapshot: the SSE hello burst that seeds
 * every subscriber can be up to five minutes old outside a service, so reading
 * the skew from it on mount produced a skew of minus several minutes instead of
 * 0, and every consumer (the context bar clock, PVP's progress bar, the
 * countdown in the rundown) rendered several minutes fast until the next real
 * frame arrived. `useResyncOn` runs its reset on mount too, so this hook eats
 * that first call itself rather than acting on it — do not "simplify" it back
 * into a bare `useResyncOn` call.
 */
export function useServerSkew(serverNow: string | null | undefined): number {
  const [skewMs, setSkewMs] = useState(0);
  const [mounted, setMounted] = useState(false);
  useResyncOn([serverNow], () => {
    if (!mounted) {
      setMounted(true);
      return;
    }
    if (serverNow) {
      const serverMs = Date.parse(serverNow);
      if (Number.isFinite(serverMs)) setSkewMs(serverMs - Date.now());
    }
  });
  return skewMs;
}
