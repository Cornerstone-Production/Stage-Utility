// legacy-page-routes.ts — pages that moved, answered with a permanent redirect.
//
// Displays and bookmarks point at /scriptview and everything under it, and they
// keep pointing there: a stage tablet is set up once and left alone. The answer
// is a 301 to the same path under /servicecue with the whole query string intact
// (`?plan=`, `?text=`, `?transport=poll` all carry state a display depends on).
//
// Which URLs moved is operator-paths.ts's legacyPageRedirect, shared with the
// Vite dev server and the client router so the three cannot disagree.
//
// Runs in EARLY_ROUTE_MODULES (remote-server.ts): the static arm serves the SPA
// shell for any path that looks like a page, so a handler placed after it would
// never see the request.

import { legacyPageRedirect } from "./operator-paths.js";
import type { RouteCtx } from "./context.js";

export async function legacyPageRoutes({ res, pathname, url, method }: RouteCtx): Promise<void> {
  if (method !== "GET" && method !== "HEAD") return;
  const target = legacyPageRedirect(pathname, url.search);
  if (target === null) return;
  res.writeHead(301, { Location: target });
  res.end();
}
