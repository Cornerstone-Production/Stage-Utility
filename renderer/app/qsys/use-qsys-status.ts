// The Q-SYS connection, as the pages that show it follow it: read once, then kept
// current by the qsys:status channel. One hook for /qsys/manage and the sidebar,
// so they cannot disagree about whether a Core is set up.

import { useEffect } from "react";
import { onNotification } from "../../lib/api";
import { useRead } from "../../lib/use-read";

export type Status = {
  connected: boolean;
  state: "connected" | "reconnecting" | "offline";
  designName: string | null;
  isEmulator: boolean | null;
  /** A Core is set up: the integration is enabled with an address. */
  configured?: boolean;
};

/** The connection, read once and then followed on qsys:status: null until known,
 *  and `failed` when the read failed and no push has come since. */
export function useQsysStatus(): { status: Status | null; failed: boolean } {
  const [read, put] = useRead<Status>("qsys:status", "qsys", "the Q-SYS connection");
  useEffect(() => onNotification("qsys:status", (p) => put(p as Status)), [put]);
  return { status: read.state === "ok" ? read.value : null, failed: read.state === "failed" };
}
