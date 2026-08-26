// Rail + context bar + page header + content. The one layout every operator
// surface renders inside, which is what makes the app feel like one program
// rather than a set of pages that happen to share a server.
//
// The responsive layout is SplitView's job, not this file's — inline sidebar on
// desktop, icon rail when collapsed, and a hamburger-opened drawer on mobile.
// A first pass rendered the rail directly and had no mobile drawer at all: the
// sidebar sat expanded on a phone with no way to dismiss it.

import { Outlet, useRouterState } from "@tanstack/react-router";
import { SplitView } from "../components/ui/split-view";
import { useRouteResetKey } from "./route-reset";
import { Rail } from "./rail";
import { PageActionsProvider, PageActionsSlot, usePageActionsSlot } from "./page-actions";
import { ContextBar } from "./context-bar";
import { ALL_DESTINATIONS } from "./destinations";
import { useStageLiveWiring } from "./live-wiring";
import { UpdateNotices } from "./update-notices";
import { useStageStateQuery } from "./queries";
import { useSidebarCollapsed } from "../lib/use-sidebar-collapsed";
import { useSidebarWidth, RAIL_WIDTH } from "../lib/use-sidebar-width";

/**
 * Title + description for the active destination, matching the per-section
 * header the settings panel shows. Nested routes (a ScriptView plan) render
 * their own heading, so nothing is shown for them rather than a wrong one.
 */
function PageHeader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = ALL_DESTINATIONS.find((d) => d.path === pathname);
  const actions = usePageActionsSlot();
  if (!active) return null;
  return (
    // The title and the route's own controls share ONE row. Home used to put its
    // Edit control on a second row below this one, which cost a whole band of
    // vertical space on the page that most wants it for content.
    // HIDDEN ON MOBILE. The top bar already shows the destination's name, so
    // this repeated it — "Home" twice, plus a description, plus its own padding,
    // for about 85px of a 844px phone screen spent saying what the bar above it
    // just said. The actions move to that bar instead; the description is a
    // desktop luxury.
    <header className="max-sm:hidden px-5 pt-5 shrink-0 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-title2 font-semibold text-fg leading-tight">{active.label}</h1>
        <p className="text-footnote text-fg-muted mt-1 max-w-[68ch]">{active.description}</p>
      </div>
      {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
    </header>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Longest match first: /settings/branding must beat /settings.
  const active = [...ALL_DESTINATIONS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((d) => pathname === d.path || pathname.startsWith(`${d.path}/`));
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
        mobileTitle={active?.label}
        // On a phone the top bar IS the page header — see PageHeader.
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
          <ContextBar />
          <PageHeader />
          {/* Page gutter, applied ONCE here rather than by each route. Routes were
                padding themselves individually and the ones added recently did not,
                so the editor and Screens sat flush against the right edge. */}
          <main className="flex-1 min-h-0 overflow-y-auto px-5 max-sm:px-3">
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
