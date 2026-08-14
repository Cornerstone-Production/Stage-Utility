// Live service state, above every operator surface.
//
// The state is not new - use-dashboard-state already carries it - but until now
// it existed only on whichever View happened to render it, so /patch could not
// tell a service was live. Hoisting it here is what makes separate pages read as
// one program.
//
// The timer maths is NOT reimplemented here. computePcoTimer already mirrors
// PCO's semantics (counts down to the service start pre-service, down each
// item's length while live, negative on overrun, up for an item with no set
// length) and fmtDuration already formats it. The dashboard and the stage
// display use the same pair; a third copy would be a third place for the same
// bug.
//
// The item set is fixed in Phase 1a. It becomes a configurable registry in
// Phase 3, alongside integration health and recording status; generalising now
// would produce a registry with one consumer and nothing to generalise from.

import { useEffect, useState } from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDashboardState } from "../main/use-dashboard-state";
import { computePcoTimer, fmtDuration } from "../main/pco-timer";
import { cn } from "../lib/cn";

export interface ContextBarState {
  isLive: boolean;
  isOver: boolean;
  /** The live item's title, or the pre-service label. */
  itemTitle: string | null;
  /** Formatted countdown, or null when nothing is live. */
  timerText: string | null;
}

/**
 * The bar's derived state. Pure, so it is testable without rendering.
 *
 * `skewMs` is `Date.parse(pcoLive.serverNow) - Date.now()` from the last
 * pco:live - the server sends serverNow for exactly this. A laptop whose clock
 * has drifted otherwise runs a timer that disagrees with the one on the wall.
 */
export function contextBarState(
  pcoLive: PcoLiveDTO | null,
  now: number,
  skewMs: number,
): ContextBarState {
  const timer = computePcoTimer(pcoLive, now, skewMs);
  if (!timer) return { isLive: false, isOver: false, itemTitle: null, timerText: null };
  return {
    isLive: true,
    isOver: timer.over,
    itemTitle: timer.label,
    timerText: fmtDuration(timer.seconds),
  };
}

export function ContextBar() {
  const { state, pcoLive } = useDashboardState();

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    // Cleanup is load-bearing: the operator app is a persistent shell, so an
    // interval that outlives its component runs for the whole service.
    return () => clearInterval(id);
  }, []);

  // Skew between this client and the server, recomputed whenever a pco:live
  // arrives. Same pattern as dashboard-view.tsx.
  const [skewMs, setSkewMs] = useState(0);
  useResyncOn([pcoLive?.serverNow], () => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  });

  const bar = contextBarState(pcoLive, now, skewMs);

  return (
    // No bottom rule and no separate surface: it sits on the content background,
    // so the page reads as one plane rather than a stack of bordered strips.
    <header className="flex items-center gap-3 h-11 shrink-0 px-5 max-sm:px-3">
      <span className="text-footnote text-fg-muted truncate shrink-0">
        {state?.serviceTypeName ?? "No service type"}
      </span>

      {state?.planTitle && (
        <span className="text-footnote text-fg truncate">{state.planTitle}</span>
      )}

      {bar.isLive && (
        <span className="flex items-center gap-2.5 ml-auto shrink-0">
          {bar.itemTitle && (
            <span className="text-footnote text-fg-muted truncate max-w-56">{bar.itemTitle}</span>
          )}
          <span className="size-1.5 rounded-full bg-live-9" aria-hidden="true" />
          <span className="text-caption2 font-medium uppercase tracking-wider text-live-11">
            Live
          </span>
          <span
            className={cn(
              "text-footnote font-mono tabular-nums",
              bar.isOver ? "text-danger-11" : "text-fg",
            )}
          >
            {bar.timerText}
          </span>
        </span>
      )}
    </header>
  );
}
