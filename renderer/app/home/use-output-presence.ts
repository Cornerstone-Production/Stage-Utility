// Which outputs are connected right now.
//
// The server already tracks this: `presenceSnapshot()` is pushed when an SSE
// opens, and `displays:presence` broadcasts only when the connected SET changes
// (heartbeats themselves are silent, per the house SSE efficiency rule). So this
// hook subscribes and holds the last set — no polling, and nothing to hydrate
// separately because the hello burst carries the snapshot.

import { useEffect, useState } from "react";
import { onNotification } from "../../lib/api";

/** Output ids currently connected. Empty is a legitimate answer — nothing is on. */
export function useOutputPresence(): readonly string[] {
  const [connected, setConnected] = useState<readonly string[]>([]);

  useEffect(() => {
    return onNotification("displays:presence", (payload: unknown) => {
      const next = (payload as { connected?: unknown } | null)?.connected;
      // Tolerant of a malformed payload rather than throwing: presence is a
      // nice-to-have on this page, and a bad frame must not blank Home.
      if (Array.isArray(next)) {
        setConnected(next.filter((id): id is string => typeof id === "string"));
      }
    });
  }, []);

  return connected;
}
