// Rail + context bar + content. The one layout every operator surface renders
// inside, which is what makes the app feel like one program rather than a set of
// pages that happen to share a server.
//
// THERE IS NO PAGE HEADER BAND ANY MORE. On a desktop the page's name and its
// actions render inside the context bar; on a phone the top bar carries them, as
// it always has. Either way one band of chrome sits above the content instead of
// two. See page-title.tsx.
//
// The responsive layout is SplitView's job, not this file's — inline sidebar on
// desktop, icon rail when collapsed, and a hamburger-opened drawer on mobile.
// A first pass rendered the rail directly and had no mobile drawer at all: the
// sidebar sat expanded on a phone with no way to dismiss it.

import { useMemo } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { SplitView } from "../components/ui/split-view";
import { PAGE_SCROLLER_ID, useRouteResetKey } from "./route-reset";
import { Rail } from "./rail";
import { PageActionsProvider, PageActionsSlot } from "./page-actions";
import { ContextBar } from "./context-bar";
import { consoleHidesChrome, consolePages, isFullBleedPath, resolvePage } from "./active-page";
import { useStageState } from "../main/use-stage-state";
import { useStageLiveWiring } from "./live-wiring";
import { UpdateNotices } from "./update-notices";
import { useStageStateQuery } from "./queries";
import { useSidebarCollapsed } from "../lib/use-sidebar-collapsed";
import { useSidebarWidth, RAIL_WIDTH } from "../lib/use-sidebar-width";
import { cn } from "../lib/cn";

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The LIVE state, the same source the rail reads. A console's name is the
  // operator's to change, and the rail entry and the page title must not be able
  // to disagree about what it is.
  const { state: liveState } = useStageState();
  const consoles = useMemo(() => consolePages(liveState?.views), [liveState?.views]);
  const active = useMemo(() => resolvePage(pathname, consoles), [pathname, consoles]);
  // A route that paints its own surface edge to edge has no page to give air to,
  // so it does not get the gutter under the strip. A console, and the ScriptView
  // rundown, which paints a kiosk surface.
  const fullBleed = useMemo(() => isFullBleedPath(pathname, liveState?.views), [pathname, liveState?.views]);
  // A console the operator has asked to run without the app's chrome. BOTH bands
  // go — the phone's top bar (SplitView's, hidden through `chromeless`) and the
  // context bar below — because 89px of an 844px phone is the number that makes
  // this worth doing, and half of it is the merge the header study already
  // rejected. On a desktop only the context bar exists to hide; the rail stays,
  // and the rail is the way back.
  //
  // Read from the LIVE state, the same source the rail reads, so turning it on
  // takes effect on the console you are standing at rather than on the next
  // reload.
  //
  // UNKNOWN IS NOT "SHOW THE BARS". `liveState` is null from first paint until
  // the hydrate lands — a real interval on a Pi — and answering `false` there
  // drew both bands and then tore them off again on every cold load of a
  // chrome-free console, re-laying-out the console under them. So on a console
  // route the bands wait until the answer is actually known. Nothing is lost by
  // waiting: ConsoleRoute itself renders null without `stageState`, so the
  // content area is empty for exactly that window either way.
  const views = liveState?.views;
  const chromeless = useMemo(
    () => (views ? consoleHidesChrome(pathname, views) : pathname.startsWith("/consoles/")),
    [pathname, views],
  );
  const { collapsed, toggle } = useSidebarCollapsed();
  const resetKey = useRouteResetKey();
  // Mounted HERE, not on a route: these subscriptions must outlive any single
  // page. On a route they would unsubscribe the moment you navigated away, and
  // the app would stop seeing live changes until you happened to come back.
  // THE QUERY MIRROR, not a second source of truth. `liveState` above is the SSE
  // module store and is what everything on this page reads; this is the React
  // Query copy, which only moves when live-wiring pushes SSE into it. It is here
  // for accentColor and for nothing else — read `views` off it and you get a
  // list that lags the rail's.
  const { data: stageState } = useStageStateQuery();
  useStageLiveWiring(stageState?.accentColor);
  const { width, dragging, startResize, reset: resetWidth } = useSidebarWidth();

  return (
    // The rail carries `bg-rail` (grayer than the content in light, seamless in
    // dark) and the content sits on `bg-bg` — the relationship the token layer
    // already describes.
    //
    // No divider rules between the rail, the context bar and the content: the
    // surfaces already separate them, and 1px lines everywhere read as seams.
    <div className="h-[100dvh] overflow-hidden bg-bg">
      {/* Here rather than on Advanced: both notices are things you should hear
          about while doing something else. Advanced is where you go to ACT on an
          update, not where you find out there is one. */}
      <UpdateNotices />
      <PageActionsProvider>
      <SplitView
        collapsed={collapsed}
        expandedWidth={width}
        railWidth={RAIL_WIDTH}
        resizing={dragging}
        mobileTitle={active?.page.label}
        // On a phone the top bar IS the page header — see page-title.tsx.
        //
        // SplitView renders this subtree only below 640px, and PageActionsEnd is
        // `display: none` there, so exactly one copy of the route's controls is
        // ever visible — and `display: none` keeps the other out of the
        // accessibility tree rather than merely off the screen. That is the
        // arrangement the page header already had; the merge did not change it.
        mobileActions={<PageActionsSlot />}
        chromeless={chromeless}
        sidebar={
          <Rail
            onToggleCollapsed={toggle}
            dragging={dragging}
            onStartResize={startResize}
            onResetWidth={resetWidth}
          />
        }
      >
        <div className="flex flex-col h-full min-w-0">
          {!chromeless && <ContextBar active={active} />}
          {/* Page gutter, applied ONCE here rather than by each route. Routes were
                padding themselves individually and the ones added recently did not,
                so the editor and Screens sat flush against the right edge. */}
          {/* The app's ONE scroller, and the only one the router knows by name —
              see PAGE_SCROLLER_ID. Without the id, TanStack identifies it by an
              `nth-child` path, which changes when the scores panel adds a
              sibling above. */}
          {/* `sm:pt-4` REPLACES THE HEADER'S OWN TOP PADDING, and only on the
              surface that had one. The header band supplied the 20px of air
              between the strip and the page; without it a desktop page starts
              flush against the bar and reads as part of it. A phone never had a
              header and gets no padding here, so nothing below 640px moves. */}
          <main
            data-scroll-restoration-id={PAGE_SCROLLER_ID}
            className={cn(
              "flex-1 min-h-0 overflow-y-auto px-5 max-sm:px-3",
              // `sm:pt-4` is the air between the band and the page. With no band
              // there is nothing for it to separate, and it would hand 16px of
              // the reclaimed height straight back as padding. The HORIZONTAL
              // gutter stays: a console cancels it with its own negative margins,
              // so dropping it here would push the console off the left edge.
              //
              // A CONSOLE NEVER GETS IT, band or no band. It fills its area edge
              // to edge, so the padding is a white band between the strip and the
              // stage-black rather than air under a page. Dropped HERE rather
              // than cancelled by the console with a negative margin: the console
              // is `h-full`, and a negative margin moves the box without giving
              // it the height back, so cancelling it that way just moved the
              // white band to the bottom.
              !chromeless && !fullBleed && "sm:pt-4",
            )}
          >
            {/* Keyed so re-selecting the active rail item remounts the route,
                returning it to its top view. */}
            <div key={resetKey} className="contents">
              <Outlet />
            </div>
          </main>
        </div>
      </SplitView>
      </PageActionsProvider>
    </div>
  );
}
