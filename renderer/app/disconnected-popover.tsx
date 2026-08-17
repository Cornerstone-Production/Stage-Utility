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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const router = useRouter();

  // Anchored in VIEWPORT coordinates, not against the trigger's own box.
  //
  // The context bar scrolls sideways from sm up, and `overflow-x: auto` computes
  // `overflow-y` to `auto` as well — so an absolutely positioned panel was
  // clipped to the bar's 44px height. Only its top few pixels showed, and its
  // rows fell outside the hit-test region entirely, so the ones you could see
  // could not be clicked. `position: fixed` resolves against the viewport, which
  // is outside that scroll container. Same technique as ContextMenu.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btnRef.current?.getBoundingClientRect();
      if (!b) return;
      const pad = 8;
      const w = panelRef.current?.offsetWidth ?? 256;
      const h = panelRef.current?.offsetHeight ?? 0;
      // Right-aligned to the trigger, because this sits in the bar's right-hand
      // group — then clamped, so it cannot hang off either edge.
      const left = Math.max(pad, Math.min(b.right - w, window.innerWidth - w - pad));
      // Below the trigger, or above it when there is no room below.
      const below = b.bottom + 4;
      const top = h && below + h > window.innerHeight - pad
        ? Math.max(pad, b.top - h - 4)
        : below;
      setPos({ top, left });
    };
    place();
    // The bar itself scrolls, and so does anything behind it. A panel that stays
    // put while its trigger moves is worse than one that is clipped.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, down.length]);

  // Close on a click anywhere else and on Escape. Both, not either: a panel you
  // can only dismiss by clicking its own trigger is a panel that gets left open
  // over the thing you were trying to read.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // The wrapper still contains the panel: `fixed` changes where a box is
      // PAINTED, not where it sits in the DOM. So this one check covers the
      // rows too. It would stop covering them the day the panel is portalled
      // out — which is the day to add the second check, with a test that can
      // fail without it.
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
        ref={btnRef}
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
        <div
          ref={panelRef}
          role="menu"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
          className={cn(
            "fixed z-[100] w-64 overflow-hidden rounded-lg",
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
