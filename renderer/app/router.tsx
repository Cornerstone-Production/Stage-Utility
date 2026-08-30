// Browser history, unlike the kiosk's router which uses memory history and
// branches on window.location in root-view.tsx. Real routing is what lets the
// shell persist across navigation - the SSE connection and the React Query
// cache survive a route change, where a document load discards both.

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { Shell } from "./shell";
import { ALL_DESTINATIONS, NESTED_ROUTES } from "./destinations";
import { SettingsIndexRoute } from "./settings-index";
import { MOVED_ROUTES, makeRedirect } from "./redirects";
import { ErrorBoundaryView } from "../components/ui/error-boundary-view";
import { PAGE_SCROLLER_SELECTOR } from "./route-reset";

const rootRoute = createRootRoute({
  component: Shell,
  errorComponent: ErrorBoundaryView,
  notFoundComponent: () => (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <p className="text-title3 text-fg">Page not found</p>
      <p className="text-body text-fg-muted">Pick a destination from the sidebar.</p>
    </div>
  ),
});

// errorComponent per route, not only on the root: a render error inside History
// must not blank the rail and strand the operator with no way out. The settings
// panel keys its ErrorBoundary by section for the same reason.
const routes = [
  ...ALL_DESTINATIONS.map((d) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: d.path,
      component: d.Component,
      errorComponent: ErrorBoundaryView,
    }),
  ),
  ...NESTED_ROUTES.map((r) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: r.path,
      component: r.Component,
      errorComponent: ErrorBoundaryView,
    }),
  ),
  // Bare /settings, plus the legacy #hash deep links that pointed into the old
  // tabbed panel. Those are in bookmarks and in Connect's copy-to-clipboard
  // links, so they redirect rather than 404.
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsIndexRoute,
    errorComponent: ErrorBoundaryView,
  }),
  // Paths that shipped and then moved. They redirect rather than 404 - see
  // redirects.tsx.
  ...Object.entries(MOVED_ROUTES).map(([from, to]) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: from,
      component: makeRedirect(to),
      errorComponent: ErrorBoundaryView,
    }),
  ),
];

const routeTree = rootRoute.addChildren(routes);

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// A NEW PAGE OPENS AT THE TOP. `scrollRestoration: true` alone did not do that,
// and the reason is worth writing down because the option reads as if it would.
//
// The router tracks whatever scrolls, and in this app exactly one thing does: the
// shell's `<main>` (`html`/`body`/`#root` are all `overflow: hidden`). On a
// forward navigation it copies the previous location's entry for every tracked
// non-window scroller onto the new location — skipping only elements named in
// `scrollToTopSelectors`, which was unset — and then applies it. Its own
// scroll-to-top call goes to `window`, which cannot scroll here, so it does
// nothing. The net effect was that every page inherited the scroll offset of the
// page before it.
//
// It read as intermittent because the browser clamps a scrollTop to what the
// content allows: a short page silently zeroed the carried offset, and a tall one
// kept it. The tall ones are every settings-shaped page, which all end in
// `pb-[50vh]` — Integrations and History among them, the two reported.
//
// Naming the pane here restores the intended split: forward navigation resets it,
// Back and Forward still restore where you were, and a deliberate in-page jump
// still wins because it runs two frames later (see flash.ts).
export const router = createRouter({
  routeTree,
  scrollRestoration: true,
  scrollToTopSelectors: [PAGE_SCROLLER_SELECTOR],
});

// No `declare module "@tanstack/react-router" { interface Register }` here.
// renderer/main/router.tsx (the kiosk) already registers, and the augmentation
// is global to the TypeScript project - two routers cannot both claim it, which
// fails with TS2717 "subsequent property declarations must have the same type".
//
// The kiosk keeps it because its declaration also carries StaticDataRouteOption.
// The cost here is that <Link to> is not narrowed to known route literals, which
// costs nothing in practice: the rail renders `to={d.path}` from DESTINATIONS,
// a dynamic string that would not narrow either way, and routes.test.tsx asserts
// those paths against the server's own table.
