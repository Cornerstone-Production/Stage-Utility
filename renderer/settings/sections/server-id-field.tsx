// The Server id row on Advanced > Network: the id screens bind to, and what the
// duplicate-id check last found.
//
// Says what the last check found and when, never a bare "all clear": the server
// checks when discovery starts and then only while another server is answering
// with its id, so "nobody answered" is only true as of that check.

import { AlertTriangleIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ServerIdentity } from "@main/types/kiosk";
import { formatClock } from "../../lib/clock-format";

/** The `data-flash-id` the row carries: Needs attention's fix points here. */
export const SERVER_ID_FLASH = "server-id";

/** The line under the id when no other server is heard. */
function checkLine(check: ServerIdentity["check"], timeZone: string | null | undefined): ReactNode {
  if (check.state === "off") return "Not checked: discovery is off, so this server neither answers nor checks.";
  if (check.state === "failed") return `Not checked: the check could not be sent${check.reason ? ` (${check.reason})` : ""}.`;
  return (
    <>
      No other server answered the last check
      {check.at ? <>, at <span className="font-mono tabular-nums">{formatClock(check.at, { timeZone })}</span></> : null}.
    </>
  );
}

export function ServerIdStatus({
  identity,
  timeZone,
  action,
}: {
  identity: ServerIdentity | undefined;
  timeZone?: string | null;
  /** What the alert offers to do about it, when anything. */
  action?: ReactNode;
}) {
  const id = identity?.id ?? null;
  const duplicates = identity?.duplicates ?? [];
  const check = identity?.check ?? { state: "off" as const };
  return (
    <div className="mt-1 flex flex-col gap-2">
      {id ? (
        <span className="self-start rounded-md border border-line bg-field px-2 py-1 font-mono text-caption1 text-fg">{id}</span>
      ) : (
        <span className="text-caption1 text-fg-muted">None yet: one is made when discovery first starts.</span>
      )}
      {duplicates.length > 0 ? (
        <div role="alert" className="flex items-start gap-2.5 rounded-[10px] border border-danger-9/30 bg-danger-9/12 p-3">
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-11" />
          <div className="min-w-0 flex-1">
            <p className="text-footnote font-semibold text-fg">Another server is using this id</p>
            <p className="mt-0.5 text-caption1 text-fg-muted">
              The server at{" "}
              {duplicates.map((d, i) => (
                <span key={d.address}>
                  {i === 0 ? "" : i === duplicates.length - 1 ? " and " : ", "}
                  <span className="font-mono">{d.address}</span>
                </span>
              ))}{" "}
              answers as this one, so screens set up here may switch between the two. Give one of them a new id.
              Screens both servers have set up stay with the one that keeps it.
            </p>
            {action ? <div className="mt-2">{action}</div> : null}
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-caption1 text-fg-muted">
          <span
            aria-hidden="true"
            className={check.state === "ok" ? "size-2 shrink-0 rounded-full bg-live-9" : "size-2 shrink-0 rounded-full border border-fg-subtle"}
          />
          <span>{checkLine(check, timeZone)}</span>
        </p>
      )}
    </div>
  );
}
