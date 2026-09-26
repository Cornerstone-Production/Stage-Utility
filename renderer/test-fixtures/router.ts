// router.ts — a real (memory-history) TanStack router for a test whose
// subject calls useRouter/navigate or renders an AppLink/Link: useRouter
// itself tolerates having no ancestor router, but Link throws outright
// without one, and a dropped guard around a navigate call would crash
// rendering rather than actually exercise the assertion around it.
//
//   const router = routerAt("/history/manage", "/history/manage", "/baptism");
//   render(React.createElement(RouterContextProvider, { router, children: … }));
//
// TEST-ONLY: no `.test.` in the filename on purpose, so `npm test`'s glob does
// not pick this up as a (zero-test) suite of its own. Imports only
// `@tanstack/react-router`, exactly as every caller already did directly, so
// moving the construction here changes nothing about when that import first
// runs relative to a caller's own `installRenderDom()`/DOM setup.

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

/**
 * A router whose history starts at `at`, with a dummy (render-nothing) route
 * registered for `at` itself (when a component under test navigates on its
 * own, e.g. to update a search param) and for every other path in
 * `destinations` a rendered AppLink/Link needs to resolve.
 */
export function routerAt(at: string, ...destinations: string[]) {
  const rootRoute = createRootRoute({});
  const routes = destinations.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  return createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
}

/** The History page (`historyPath`) plus its "Open in Baptisms" link target —
 *  for a test mounted ON the History page itself. */
export function routerWithBaptismDestination(historyPath = "/history/manage") {
  return routerAt(historyPath, historyPath, "/baptism");
}
