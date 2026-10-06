// legacy-api-routes.ts — /api/scriptview/* answers with a redirect to /api/servicecue/*.
//
// The ServiceCue API was documented as /api/scriptview/* (docs/reference/api.md),
// so a script or a stale open page may still be calling it. A 308 keeps the method
// and the body — a 301 would turn a POST into a GET — so `fetch` and curl both
// follow it to the new path and the call still does what it did. The query string
// is kept.
//
// `no-store` for the reason the page redirects use it (see movedPageHeaders): a
// permanent redirect the client remembers outlives the build that explains it.
//
// Runs in EARLY_ROUTE_MODULES with the page redirects, before the route modules
// that serve /api/servicecue, so no later module is asked about the old path.

import type { RouteCtx } from "./context.js";
import { movedPageHeaders } from "./legacy-page-routes.js";

/** Old API prefix to new. */
const MOVED_API_PREFIXES: readonly (readonly [from: string, to: string])[] = [["/api/scriptview", "/api/servicecue"]];

/**
 * Where a request for a moved API path should go, or null. Like isOperatorPath,
 * the boundary is the end of the path or a "/", never a bare prefix.
 */
export function legacyApiRedirect(pathname: string, search = ""): string | null {
  for (const [from, to] of MOVED_API_PREFIXES) {
    if (pathname === from || pathname.startsWith(`${from}/`)) {
      return `${to}${pathname.slice(from.length)}${search}`;
    }
  }
  return null;
}

export async function legacyApiRoutes({ res, pathname, url, method }: RouteCtx): Promise<void> {
  // A preflight asks whether a cross-origin write is allowed; answering it with a
  // redirect would fail the browser's check. It is left to the routes beneath.
  if (method === "OPTIONS") return;
  const target = legacyApiRedirect(pathname, url.search);
  if (target === null) return;
  res.writeHead(308, movedPageHeaders(target));
  res.end();
}
