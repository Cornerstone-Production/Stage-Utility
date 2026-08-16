// "3 disconnected" — but WHICH three?
//
// The context bar counted them and stopped there, which is the least useful
// place to stop: it tells the operator something is wrong during a service and
// leaves them to open Integrations and read every card to find out what. The
// count is the alarm; this is the answer.
//
// Clicking one goes straight to its card and outlines it, using the same
// flashTarget mechanism Getting Started uses to point at a control after
// arriving on its page — landing on the right page still leaves you hunting on a
// page as dense as Integrations.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { flashTarget } from "./flash";
import { integrationFlashId } from "../components/integrations-panel";
import { cn } from "../lib/cn";
/** Where an integration's card lives. One route, so this is not a lookup.
 *  Typed as string, matching how the rail passes a destination path — the route
 *  union is generated and a bare literal does not satisfy it. */
const INTEGRATIONS_ROUTE: string = "/settings/integrations";

export function DisconnectedPopover({
  down,
  labels,
}: {
  /** The integrations that are down. Never empty — the caller renders nothing. */
  down: readonly IntegrationState[];
  /** Friendly names, keyed by integration id. */
  labels: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  // Close on a click anywhere else and on Escape. Both, not either: a panel you
  // can only dismiss by clicking its own trigger is a panel that gets left open
  // over the thing you were trying to read.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing here closes the panel when the last integration reconnects, and
  // nothing needs to: the context bar renders this only while something is
  // down, so the component unmounts and takes its open state with it. An effect
  // that called setOpen(false) on an empty list was guarding a case the caller
  // already prevents — and eslint was right that it was a cascading render.
  //
  // A list that merely SHRINKS while open re-renders from props, as it should.

  function go(id: string) {
    setOpen(false);
    router.navigate({ to: INTEGRATIONS_ROUTE });
    flashTarget(integrationFlashId(id));
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          "rounded-md px-1.5 py-0.5 text-footnote text-warn-11 transition-colors",
          "hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          open && "bg-fill",
        )}
      >
        {down.length} disconnected
      </button>

      {open && (
        // Anchored under the trigger and pinned to the RIGHT edge, because this
        // item sits in the right-hand group of the bar — a left-anchored panel
        // would hang off the side of the window.
        <div
          role="menu"
          className={cn(
            "absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-lg",
            "border border-line bg-surface-raised shadow-lg",
          )}
        >
          <p className="border-b border-line px-3 py-2 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            Not connected
          </p>
          {down.map((i) => (
            <button
              key={i.id}
              type="button"
              role="menuitem"
              onClick={() => go(i.id)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                "border-b border-line last:border-b-0 hover:bg-fill",
                "focus-visible:outline-none focus-visible:bg-fill",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  i.connection === "error" ? "bg-danger-9" : "bg-fg-faint",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-footnote text-fg">
                  {labels[i.id] ?? i.id}
                </span>
                {/* What is actually wrong, when the integration says. "Error"
                    and "never connected" want different responses. */}
                <span className="block truncate text-caption2 text-fg-subtle">
                  {i.message ?? (i.connection === "error" ? "Connection error" : "Not connected")}
                </span>
              </span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-fg-subtle" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
