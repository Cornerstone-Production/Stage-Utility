// dev-clean-urls.ts — the Vite dev server's answer to a clean URL.
//
// vite.config.ts cannot be imported by a test (it reads __dirname, so it only
// loads inside Vite), which left the dev server's version of these rules without
// a test of its own. The logic lives here, as a plain connect-style middleware,
// and the config just installs it.
//
// It answers what remote-server.ts answers, from the same functions
// (operator-paths.ts, legacy-page-routes.ts), so dev and prod cannot disagree:
//
//   /scriptview/…              -> 301 to /servicecue/…, query kept
//   /settings, /history, …     -> app.html (the operator app)
//   /display-1, /preview-x     -> index.html (the kiosk; the slug is read client-side)

import type * as http from "node:http";

import { movedPageHeaders } from "./legacy-page-routes.js";
import { isOperatorPath, legacyPageRedirect } from "./operator-paths.js";

export function cleanUrlsMiddleware(req: http.IncomingMessage, res: http.ServerResponse, next: () => void): void {
  const raw = req.url ?? "";
  const q = raw.indexOf("?");
  const pathname = q === -1 ? raw : raw.slice(0, q);
  const moved =
    req.method === "GET" || req.method === "HEAD" ? legacyPageRedirect(pathname, q === -1 ? "" : raw.slice(q)) : null;
  if (moved !== null) {
    res.writeHead(301, movedPageHeaders(moved));
    res.end();
    return;
  }
  if (isOperatorPath(pathname)) {
    req.url = "/app.html";
  } else if (/^\/(display|preview)-[^/]+\/?$/.test(pathname)) {
    req.url = "/index.html";
  }
  next();
}
