// connection-badge.tsx — "is this thing talking to us", said the same way everywhere.
//
// One component, used by the integration tile, the integration dialog header,
// each ProPresenter instance row and each wireless receiver row. It was a local
// function inside integrations-panel.tsx while two of those four call sites
// lived in other files.

import { Tooltip } from "./ui/tooltip";
import { Status } from "./ui";
import { Loader2Icon, CheckCircle2Icon, XCircleIcon } from "lucide-react";

export function ConnectionBadge({
  connection,
  message,
  inbound,
}: {
  connection: ConnectionState;
  message?: string | null;
  /** Nothing dials out, so "disconnected" would name a fault where there is
   *  only an empty room. A listener with no client yet is waiting, not down. */
  inbound?: boolean;
}) {
  if (connection === "connected") {
    return (
      <span className="flex items-center gap-1">
        <CheckCircle2Icon className="size-3.5 text-green-10 shrink-0" />
        <span className="text-caption1 text-green-10">Connected</span>
      </span>
    );
  }
  if (connection === "connecting") {
    return (
      <span className="flex items-center gap-1">
        <Loader2Icon className="size-3.5 text-accent animate-spin shrink-0" />
        <span className="text-caption1 text-accent">Connecting…</span>
      </span>
    );
  }
  if (connection === "error") {
    // Truncate a long error (e.g. "Can't reach 192.168.x.x — ECONNREFUSED…") so it
    // never overflows its row; the full text shows on hover via the tooltip.
    return (
      <Tooltip label={message ?? "Error"}>
        <span className="flex items-center gap-1 min-w-0 max-w-[9rem] sm:max-w-md" aria-label={message ?? "Error"}>
          <XCircleIcon className="size-3.5 text-red-10 shrink-0" />
          <span className="text-caption1 text-red-10 truncate min-w-0">{message ?? "Error"}</span>
        </span>
      </Tooltip>
    );
  }
  // disconnected
  return (
    <span className="flex items-center gap-1">
      <Status variant={inbound ? "neutral" : "warning"} />
      <span className="text-caption1 text-gray-9">{inbound ? "No clients yet" : "Disconnected"}</span>
    </span>
  );
}
