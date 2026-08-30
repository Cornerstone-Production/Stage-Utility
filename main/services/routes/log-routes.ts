// log-routes.ts — the /log viewer, its /logs alias, and the JSON behind them.
//
// Not in ROUTE_MODULES. Those run AFTER the static build is offered, and the
// viewer has to be served before it, or the SPA fallback swallows /log. It is
// still a route module in shape so route-harness can drive the real handler —
// the token gate is the kind of thing that must be tested by running it, not by
// reading it.

import { appTimeZone, isFollowingHostTimeZone } from "../app-timezone.js";
import { getLevelCounts, getLogSince } from "../log-buffer.js";
import { buildLogChecks } from "../log-checks.js";
import { integrationManager } from "../integration-manager.js";
import { renderLogPage } from "../log-page.js";
import { SERVER_VERSION } from "../server-version.js";
import { type RouteCtx, error, json } from "./context.js";
import { CANONICAL_LOG_PATH, LOG_PAGE_PATHS } from "./log-paths.js";


/**
 * Optional token gate for the log surfaces. The app has no auth (LAN-trusted),
 * so these are open by default like everything else; set STAGE_UTILITY_LOG_TOKEN
 * to require `?token=…`. Logs can carry internal detail, so this is the one
 * surface with a lock available.
 *
 * Read per request rather than captured at import: it is one env lookup on a
 * diagnostic route, and capturing it made the gate untestable without reloading
 * the module.
 */
export function logAuthed(url: URL): boolean {
  const token = process.env.STAGE_UTILITY_LOG_TOKEN || null;
  return !token || url.searchParams.get("token") === token;
}

/** `?since=` as a number, or null for "give me everything". */
function parseSince(url: URL): number | null {
  const raw = url.searchParams.get("since");
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function logRoutes(c: RouteCtx): Promise<void> {
  const { res, pathname, method, url } = c;
  if (method !== "GET") return;

  if ((LOG_PAGE_PATHS as readonly string[]).includes(pathname)) {
    // ONE gate for both paths, checked before the redirect. Redirecting first
    // would answer an unauthorised /logs with a 302 and leave the 401 to happen
    // somewhere else — indistinguishable, from the outside, from an alias that
    // skips the check.
    if (!logAuthed(url)) {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Unauthorized — append ?token=…");
      return;
    }
    if (pathname !== CANONICAL_LOG_PATH) {
      // 302, not 301: a permanent redirect is cached by the browser until the
      // user clears it, and there is no way to reach into an operator's browser
      // on a LAN appliance if this ever has to change.
      res.writeHead(302, { Location: CANONICAL_LOG_PATH + url.search, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(renderLogPage(appTimeZone()));
    return;
  }

  if (pathname === "/api/log") {
    if (!logAuthed(url)) {
      error(res, "unauthorized", 401);
      return;
    }
    const slice = getLogSince(parseSince(url));
    json(res, {
      ...slice,
      // Counted over the whole buffer, not over the slice — "3 errors" has to
      // mean the log, not whatever arrived in the last two seconds.
      checks: buildLogChecks({
        version: SERVER_VERSION,
        uptimeSec: process.uptime(),
        timeZone: appTimeZone(),
        followingHost: isFollowingHostTimeZone(),
        ...getLevelCounts(),
        states: integrationManager.getStates(),
        descriptors: integrationManager.getDescriptors(),
      }),
    });
    return;
  }
}
