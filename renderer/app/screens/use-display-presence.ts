// Which screens have a live page connected right now.
//
// The server broadcasts the connected-output set on change and kiosk pages
// heartbeat to keep it fresh. Two things on the Screens page read it — a card's
// Online dot, and the Screen settings panel's device line — so it is one hook,
// not a subscription written twice.

import { useEffect, useState } from "react";

import { onNotification } from "../../lib/api";

export function useDisplayPresence(): Set<string> {
  const [connected, setConnected] = useState<Set<string>>(new Set());
  useEffect(
    () =>
      onNotification("displays:presence", (p: unknown) => {
        const ids = (p as { connected?: string[] } | null)?.connected ?? [];
        setConnected(new Set(ids));
      }),
    [],
  );
  return connected;
}
