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
import { consolePages, resolvePage } from "./active-page";
import { useStageState } from "../main/use-stage-state";
import { useStageLiveWiring } from "./live-wiring";
import { UpdateNotices } from "./update-notices";
import { useStageStateQuery } from "./queries";
import { useSidebarCollapsed } from "../lib/use-sidebar-collapsed";
import { useSidebarWidth, RAIL_WIDTH } from "../lib/use-sidebar-width";

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The LIVE state, the same source the rail reads. A console's name is the
  // operator's to change, and the rail entry and the page title must not be able
  // to disagree about what it is.
  const { state: liveState } = useStageState();
  const consoles = useMemo(() => consolePages(liveState?.views), [liveState?.views]);
  const active = useMemo(() => resolvePage(pathname, consoles), [pathname, consoles]);
  const { collapsed, toggle } = useSidebarCollapsed();
  const resetKey = useRouteResetKey();
  // Mounted HERE, not on a route: these subscriptions must outlive any single
  // page. On a route they would unsubscribe the moment you navigated away, and
  // the app would stop seeing live changes until you happened to come back.
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
          <ContextBar active={active} />
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
            className="flex-1 min-h-0 overflow-y-auto px-5 max-sm:px-3 sm:pt-4"
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
