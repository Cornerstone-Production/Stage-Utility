// The public viewer's router and the frame it draws pages in.
//
// Two routes and nothing else: the ServiceCue launcher and a ServiceCue rundown, the
// same pages the operator app's own table mounts (they are defined in
// servicecue-routes.tsx for that reason), so the pages cannot be a copy.
//
// What is NOT here is the operator shell: no rail, no context bar, no update
// notices, no device scan, none of the live wiring that keeps an operator's page
// current. A visitor is not an operator, and the Worker answers none of the
// addresses that wiring would ask for.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet, createRootRoute, createRoute, createRouter, useParams, type RouterHistory } from "@tanstack/react-router";

import { SERVICECUE_LANDING_PATH, SERVICECUE_PLAN_PATH, ServiceCuePlanRoute, ServiceCueShared } from "../app/servicecue-routes";
import { ErrorBoundaryView } from "../components/ui/error-boundary-view";
import { cn } from "../lib/cn";
import { refreshWhileMounted } from "../lib/live-refresh";
import { useTheme } from "../lib/use-theme";
import { UPCOMING_PLANS_QUERY } from "../settings/sections/plan-switcher";
import { StaleNotice } from "./stale-notice";

/**
 * The frame a ServiceCue page is drawn in with no chrome around it: the same
 * structure the operator shell gives these two pages at `/servicecue`, so each
 * looks as it does on a stage tablet. A rundown paints its own kiosk surface edge
 * to edge, so it is not given the gutter under the top that the launcher is.
 */
export function PublicShell() {
  // The launcher follows the visitor's light or dark, as it does in the building;
  // a rundown is always dark. The class on <html> is this hook's to keep, and a
  // browser with no saved choice follows the system, which is every visitor's case.
  useTheme();
  // The plan switcher's list is a query, read once and kept for minutes: when the
  // Worker says the plans changed, it is read again.
  const queryClient = useQueryClient();
  useEffect(
    () => refreshWhileMounted(() => void queryClient.invalidateQueries({ queryKey: [UPCOMING_PLANS_QUERY] }), ["plans-upcoming"], null),
    [queryClient],
  );
  const { layout } = useParams({ strict: false }) as { layout?: string };
  const fullBleed = layout !== undefined;

  return (
    <div className="h-[100dvh] overflow-hidden bg-bg">
      <div className="flex flex-col h-full min-w-0">
        {/* A row of its own above the page, so that when it is there it pushes the page
            down and covers none of it. See stale-notice.tsx. */}
        <StaleNotice />
        <main className={cn("flex-1 min-h-0 overflow-y-auto px-2 max-sm:px-3", !fullBleed && "sm:pt-4")}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function PublicNotFound() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <p className="text-title3 text-fg">Page not found</p>
      <p className="text-body text-fg-muted">
        <a href="/servicecue" className="text-accent hover:underline">
          Back to ServiceCue
        </a>
      </p>
    </div>
  );
}

/** The viewer's router. `history` is for a test; the page uses the browser's. */
export function createPublicRouter(history?: RouterHistory) {
  const root = createRootRoute({ component: PublicShell, errorComponent: ErrorBoundaryView, notFoundComponent: PublicNotFound });
  const pages = [
    createRoute({ getParentRoute: () => root, path: SERVICECUE_LANDING_PATH, component: ServiceCueShared, errorComponent: ErrorBoundaryView }),
    createRoute({ getParentRoute: () => root, path: SERVICECUE_PLAN_PATH, component: ServiceCuePlanRoute, errorComponent: ErrorBoundaryView }),
  ];
  return createRouter({ routeTree: root.addChildren(pages), ...(history ? { history } : {}) });
}
