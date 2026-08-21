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
// WHICH items appear, in what order, and where the left/right split falls are
// all the operator's, and all live in bar-items.ts. This file renders them.

import { useEffect, useState } from "react";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDashboardState } from "../main/use-dashboard-state";
import { computePcoTimer, fmtDuration } from "../main/pco-timer";
import { cn } from "../lib/cn";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { ContextMenu, type ContextMenuItem } from "../components/ui/context-menu";
import { BarConfigurator } from "./bar-configurator";
import { BAR_SPACE, BAR_SPACER, visibleBarItems, type BarItemId } from "./bar-items";
import { recordingStat, recorders, streamingStat, streamers } from "./recording-status";
import { useObsState } from "../main/use-obs-state";
import { useReaperState } from "../main/use-reaper-state";
import { useIntegrations } from "../main/use-integration-states";
import { useResiState, useYouTubeState } from "../main/use-stream-state";
import { DisconnectedPopover } from "./disconnected-popover";
import { formatClock } from "../lib/clock-format";

/** Everything an item needs to render. Gathered by `useBarContext`. */
export interface BarItemContext {
  state: StageState | null | undefined;
  bar: ContextBarState;
  now: number;
  obs: ReturnType<typeof useObsState>;
  reaper: ReturnType<typeof useReaperState>;
  integrations: ReturnType<typeof useIntegrations>;
  resi: StreamStatusDTO | null;
  youtube: StreamStatusDTO | null;
}

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
    // LIVE means an ITEM is running, not merely that there is something to count.
    // This was `true` for any timer at all, so a service two days away — which
    // produces a perfectly good pre-service countdown — lit the green LIVE badge
    // above every page. The bar was simultaneously saying "starts in 2d 0h" and
    // "live", and only one of those can be true.
    isLive: timer.mode === "item",
    isOver: timer.over,
    itemTitle: timer.label,
    timerText: fmtDuration(timer.seconds),
  };
}

/** Everything the items read, gathered once.
 *
 *  A hook rather than props so the configurator's preview can render the SAME
 *  items from the SAME live data — a preview fed placeholder values would not be
 *  a preview of anything. */
export function useBarContext(): BarItemContext {
  const { state, pcoLive } = useDashboardState();
  // Shared with the layout objects that show the same facts - hooks, not
  // components, so a compact strip and a canvas box stay separate presentations.
  const obs = useObsState();
  const reaper = useReaperState();
  const integrations = useIntegrations();
  const resi = useResiState();
  const youtube = useYouTubeState();

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
  return { state, bar, now, obs, reaper, integrations, resi, youtube };
}

/** The strip's own layout. Shared with the configurator's preview, so a bar that
 *  looks right there looks right above the page.
 *
 *  No bottom rule and no separate surface: it sits on the content background, so
 *  the page reads as one plane rather than a stack of bordered strips. WRAPS on
 *  a phone, one row from sm up.
 *
 *  Scrolling was the first fix and it was the wrong one: it stopped the items
 *  colliding, but pushed "3 disconnected" and "REC stopped" off the right edge,
 *  and an alert you have to swipe sideways to find is not an alert. Wrapping
 *  shows every reading at once and still cannot overlap. */
export const BAR_STRIP_CLASS =
  "flex flex-wrap items-center gap-x-3 gap-y-0.5 px-5 max-sm:px-3 py-1.5 sm:h-11 sm:flex-nowrap sm:py-0";

/** One item's box in the strip.
 *
 *  shrink-0 on EVERY item. With min-w-0 they squeezed past their own content on
 *  a phone and printed over each other. */
export const BAR_ITEM_CLASS = "flex items-center gap-2.5 shrink-0";

/**
 * A flexible space: it draws nothing and eats the slack.
 *
 * flex-1 only once the bar is a single row. On a wrapped bar it would claim the
 * whole remainder of whatever line it landed on and push the next item onto a
 * line of its own, so on a phone the items simply pack and wrap.
 */
export function BarSpacerEl({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("hidden sm:block sm:flex-1", className)} />;
}

/**
 * A fixed gap: a deliberate break between two groups.
 *
 * Geometry lives in styles.css under `.bar-space`, because it needs a sibling
 * selector that a utility class cannot express — see the comment there for why
 * two of them in a row would otherwise fail to add up.
 *
 * Unlike the flexible spacer this DOES show on a wrapped phone bar: it is the
 * same width at any screen size, which is the whole reason to reach for it.
 */
export const BAR_SPACE_CLASS = "bar-space";

export function BarSpaceEl({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block", BAR_SPACE_CLASS, className)} />;
}

export function ContextBar() {
  const ctx = useBarContext();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [configuring, setConfiguring] = useState(false);

  // Rendered once each, in the operator's order, and EVERY item renders — an
  // item with nothing to report says so rather than vanishing.
  //
  // Items used to return null when idle, which was quieter and wrong: the bar
  // reflowed as the state changed. Integration health appeared only once
  // something broke, so its arrival moved everything beside it; between services
  // the whole right-hand group was absent and the bar packed left. An operator
  // cannot learn where to look on a strip that rearranges itself.
  const rows = visibleBarItems(ctx.state?.barItems);

  const menuItems: ContextMenuItem[] = [
    { label: "Configure bar…", onSelect: () => setConfiguring(true) },
  ];

  function openMenu(e: ReactMouseEvent) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }

  return (
    <>
      <header className={cn("context-strip shrink-0", BAR_STRIP_CLASS)} onContextMenu={openMenu}>
        {rows.map((id, i) => {
          if (id === BAR_SPACER) return <BarSpacerEl key={`${id}-${i}`} />;
          if (id === BAR_SPACE) return <BarSpaceEl key={`${id}-${i}`} />;
          return (
            <span key={id} className={BAR_ITEM_CLASS}>
              {renderBarItem(id, ctx)}
            </span>
          );
        })}
      </header>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      <BarConfigurator open={configuring} onOpenChange={setConfiguring} rows={rows} />
    </>
  );
}

/**
 * An item with nothing to report.
 *
 * One component so the resting treatment is stated once. It is the thing most
 * likely to be revisited — whether idle should be grey at all was the question
 * this change turned on — and three hand-written copies is three chances for it
 * to end up meaning three different things.
 */
function Idle({ children }: { children: ReactNode }) {
  return <span className="text-footnote text-fg-subtle truncate">{children}</span>;
}

/**
 * One item's contents. NEVER null: see the loop above.
 *
 * Exported for the guard that holds that promise — the idle branches are easy
 * to drop, and dropping one brings back a bar that rearranges itself.
 */
export function renderBarItem(id: BarItemId, ctx: BarItemContext): ReactNode {
  const { state, bar, now, obs, reaper, integrations, resi, youtube } = ctx;
  switch (id) {
    case "clock":
      return (
        <span className="text-footnote font-mono tabular-nums text-fg-muted">
          {formatClock(now, { seconds: true })}
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
      // What PCO says is happening NOW, so between services the honest reading
      // is that nothing is — not an absent item.
      return bar.isLive && bar.itemTitle ? (
        <span className="text-footnote text-fg-muted truncate max-w-56">{bar.itemTitle}</span>
      ) : (
        <Idle>No item</Idle>
      );

    case "live-timer":
      // Always the same three parts — dot, word, time — so the item keeps its
      // shape and only its COLOUR changes. Grey is the resting state; green
      // means a service is running.
      //
      // Idle is deliberately not red. Red on this bar means "act now", and it
      // is already spent on an overrun and on a recorder that has stopped
      // mid-service. Lit every day for a state that is entirely normal, it
      // would stop reading as an alarm on the one morning it is.
      return (
        <>
          <span
            className={cn("size-1.5 rounded-full", bar.isLive ? "bg-live-9" : "bg-fg-faint")}
            aria-hidden="true"
          />
          <span
            aria-hidden="true"
            className={cn(
              "text-caption2 font-medium uppercase tracking-wider",
              bar.isLive ? "text-live-11" : "text-fg-subtle",
            )}
          >
            Live
          </span>
          {/* The word stays "Live" either way and only its COLOUR changes,
              which a screen reader cannot see. So the visible word is hidden
              from it and the state is spelled out instead — not an aria-label
              on the span above, which has no role to hang one off. */}
          <span className="sr-only">{bar.isLive ? "Live" : "Not live"}</span>
          {/* Pre-service, the timer's own label says what it is counting to. */}
          {!bar.isLive && bar.itemTitle && (
            <span className="text-footnote text-fg-subtle truncate">{bar.itemTitle}</span>
          )}
          <span
            className={cn(
              "text-footnote font-mono tabular-nums",
              // Overrun stays red whether or not an item is running: a start
              // time that has passed with nothing begun is worth the same look.
              bar.isOver ? "text-danger-11" : bar.isLive ? "text-fg" : "text-fg-subtle",
            )}
          >
            {bar.timerText ?? "—"}
          </span>
        </>
      );

    case "integration-health": {
      // Only ones the operator has actually SET UP: an integration nobody
      // configured is not "disconnected", it is absent, and counting it would
      // make the bar permanently complain about gear this church does not own.
      const setUp = (integrations?.states ?? []).filter((i) => i.enabled && i.configured !== false);
      const down = setUp.filter((i) => i.connection === "error" || i.connection === "disconnected");
      // A count on its own is the least useful place to stop: it says something
      // is wrong mid-service and leaves you to open Integrations and read every
      // card to find out what. Clicking it names them and takes you there.
      if (down.length > 0) return <DisconnectedPopover down={down} labels={integrations?.labels ?? {}} />;
      // Healthy reads grey, not green: the reassurance is that the item is
      // there and NOT red, which is legible at a glance without adding a
      // second colour to a strip whose colours all mean "look here".
      return <Idle>{setUp.length === 0 ? "No integrations" : "All connected"}</Idle>;
    }

    case "streaming": {
      // The same judgement Home makes, from the same function — including
      // "connected but not live", which mid-service is the state worth seeing.
      const st = streamingStat(streamers(resi, youtube, obs), now);
      // No tone is streamingStat's "no platform is even connected" — unknown,
      // not off air, and the one streaming state not worth a colour.
      if (!st.tone) return <Idle>No stream</Idle>;
      return (
        <span className={cn("text-footnote font-mono tabular-nums", st.tone === "danger" ? "text-danger-11" : "text-live-11")}>
          {st.tone === "danger" ? "Off air" : st.value}
        </span>
      );
    }

    case "recording": {
      // The same judgement Home makes, from the same function - including
      // "connected but stopped", which is the state worth surfacing.
      const rec = recordingStat(recorders(obs, reaper));
      // No tone is recordingStat's "nothing is even connected" — the one
      // recording state that is not worth a colour.
      if (!rec.tone) return <Idle>No recorder</Idle>;
      return (
        <span className={cn("text-footnote font-mono tabular-nums", rec.tone === "danger" ? "text-danger-11" : "text-live-11")}>
          {rec.tone === "danger" ? "REC stopped" : rec.value}
        </span>
      );
    }
  }
}
