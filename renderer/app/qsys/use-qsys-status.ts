// The Q-SYS connection, as the pages that show it follow it: read once, then kept
// current by the qsys:status channel. One hook for /qsys/manage and the sidebar,
// so they cannot disagree about whether a Core is set up.

import { useEffect, useState } from "react";
import { invoke, onNotification } from "../../lib/api";
import { logReadFailure } from "../../lib/client-log";

export type Status = {
  connected: boolean;
  state: "connected" | "reconnecting" | "offline";
  designName: string | null;
  isEmulator: boolean | null;
  /** A Core is set up: the integration is enabled with an address. */
  configured?: boolean;
};

/** The connection, read once and then followed on qsys:status. Null until known. */
export function useQsysStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    invoke<Status>("qsys:status").then(
      (st) => live && setStatus((cur) => cur ?? st),
      (err: unknown) => logReadFailure("qsys", "the Q-SYS connection", err),
    );
    const off = onNotification("qsys:status", (p) => live && setStatus(p as Status));
    return () => {
      live = false;
      off();
    };
  }, []);
  return status;
}
