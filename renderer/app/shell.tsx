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
import { Rail } from "./rail";
import { ContextBar } from "./context-bar";
import { DESTINATIONS } from "./destinations";
import { useSidebarCollapsed } from "../lib/use-sidebar-collapsed";
import { useSidebarWidth, RAIL_WIDTH } from "../lib/use-sidebar-width";

/**
 * Title + description for the active destination, matching the per-section
 * header the settings panel shows. Nested routes (a ScriptView plan) render
 * their own heading, so nothing is shown for them rather than a wrong one.
 */
function PageHeader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = DESTINATIONS.find((d) => d.path === pathname);
  if (!active) return null;
  return (
    <header className="px-5 max-sm:px-3 pt-5 max-sm:pt-4 shrink-0">
      <h1 className="text-title2 font-semibold text-fg leading-tight">{active.label}</h1>
      <p className="text-footnote text-fg-muted mt-1 max-w-[68ch]">{active.description}</p>
    </header>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = DESTINATIONS.find((d) => pathname === d.path || pathname.startsWith(`${d.path}/`));
  const { collapsed, toggle } = useSidebarCollapsed();
  const { width, dragging, startResize, reset: resetWidth } = useSidebarWidth();

  return (
    // The rail carries `bg-rail` (grayer than the content in light, seamless in
    // dark) and the content sits on `bg-bg` — the relationship the token layer
    // already describes.
    //
    // No divider rules between the rail, the context bar and the content: the
    // surfaces already separate them, and 1px lines everywhere read as seams.
    <div className="h-[100dvh] overflow-hidden bg-bg">
      <SplitView
        collapsed={collapsed}
        expandedWidth={width}
        railWidth={RAIL_WIDTH}
        resizing={dragging}
        mobileTitle={active?.label}
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
          <main className="flex-1 min-h-0 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </SplitView>
    </div>
  );
}
