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
import type { ReactNode } from "react";
import { visibleBarItems, type BarItemId } from "./bar-items";
import { recordingStat } from "./recording-status";
import { useObsState } from "../main/use-obs-state";
import { useReaperState } from "../main/use-reaper-state";
import { useIntegrations } from "../main/use-integration-states";

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
  // Shared with the layout objects that show the same facts - hooks, not
  // components, so a compact strip and a canvas box stay separate presentations.
  const obs = useObsState();
  const reaper = useReaperState();
  const integrations = useIntegrations();

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

  const items = visibleBarItems(state?.barItems);
  // Rendered once each, in the operator's order. Items that have nothing to say
  // right now return null and take no space, so the bar stays quiet rather than
  // filling with em dashes.
  const rendered = items
    .map((id) => ({ id, node: renderBarItem(id, { state, bar, now, obs, reaper, integrations }) }))
    .filter((x) => x.node !== null);

  return (
    // No bottom rule and no separate surface: it sits on the content background,
    // so the page reads as one plane rather than a stack of bordered strips.
    <header className="flex items-center gap-3 h-11 shrink-0 px-5 max-sm:px-3">
      {rendered.map((x, i) => (
        <span
          key={x.id}
          // The first live-ish item pushes the rest right, preserving the
          // original bar's shape: context on the left, service state on the right.
          className={cn("flex items-center gap-2.5 min-w-0", i === RIGHT_FROM(rendered) && "ml-auto shrink-0")}
        >
          {x.node}
        </span>
      ))}
    </header>
  );
}

/** Where the right-hand group starts: the first of the "service state" items
 *  present. Keeps the shipped bar's left/right split without hard-coding it. */
const RIGHT_ITEMS = new Set<BarItemId>(["live-timer", "current-item", "integration-health", "recording"]);
function RIGHT_FROM(rendered: { id: BarItemId }[]): number {
  return rendered.findIndex((x) => RIGHT_ITEMS.has(x.id));
}

function renderBarItem(
  id: BarItemId,
  ctx: {
    state: StageState | null | undefined;
    bar: ContextBarState;
    now: number;
    obs: ReturnType<typeof useObsState>;
    reaper: ReturnType<typeof useReaperState>;
    integrations: ReturnType<typeof useIntegrations>;
  },
): ReactNode {
  const { state, bar, now, obs, reaper, integrations } = ctx;
  switch (id) {
    case "clock":
      return (
        <span className="text-footnote font-mono tabular-nums text-fg-muted">
          {new Date(now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}
        </span>
      );

    case "plan":
      return (
        <>
          <span className="text-footnote text-fg-muted truncate shrink-0">
            {state?.serviceTypeName ?? "No service type"}
          </span>
          {state?.planTitle && (
            <span className="text-footnote text-fg truncate">{state.planTitle}</span>
          )}
        </>
      );

    case "current-item":
      // Only while live, and only when PCO actually names an item.
      return bar.isLive && bar.itemTitle
        ? <span className="text-footnote text-fg-muted truncate max-w-56">{bar.itemTitle}</span>
        : null;

    case "live-timer":
      return bar.isLive ? (
        <>
          <span className="size-1.5 rounded-full bg-live-9" aria-hidden="true" />
          <span className="text-caption2 font-medium uppercase tracking-wider text-live-11">Live</span>
          <span className={cn("text-footnote font-mono tabular-nums", bar.isOver ? "text-danger-11" : "text-fg")}>
            {bar.timerText}
          </span>
        </>
      ) : null;

    case "integration-health": {
      // Counts what is DISCONNECTED. Nothing when all is well: a bar item that
      // is permanently green is noise, and noise is what gets ignored.
      // Only ones the operator has actually SET UP: an integration nobody
      // configured is not "disconnected", it is absent, and counting it would
      // make the bar permanently complain about gear this church does not own.
      const down = (integrations?.states ?? []).filter(
        (i) => i.enabled && i.configured !== false && (i.connection === "error" || i.connection === "disconnected"),
      );
      if (down.length === 0) return null;
      return (
        <span className="text-footnote text-warn-11 truncate">
          {down.length} disconnected
        </span>
      );
    }

    case "recording": {
      // The same judgement Home makes, from the same function - including
      // "connected but stopped", which is the state worth surfacing.
      const rec = recordingStat(obs, reaper);
      if (rec.value === "—") return null;
      return (
        <span className={cn("text-footnote font-mono tabular-nums", rec.tone === "danger" ? "text-danger-11" : "text-live-11")}>
          {rec.tone === "danger" ? "REC stopped" : rec.value}
        </span>
      );
    }
  }
}
