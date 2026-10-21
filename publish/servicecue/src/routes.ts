// routes.ts — which request is which.
//
// Plain functions of a method and a URL, with no Workers API in them, so the root
// test suite can put every kind of path to them. The Worker answers ONLY what is
// named here: a path that is not named is a 404, never a fallback to something
// near it, and that is the whole of the defence against a traversal or a
// look-alike. The URL parser has already resolved `.` and `..` segments before a
// request gets here, so what is judged is the path they resolve to; an encoded
// slash, a backslash or an empty segment arrives verbatim and matches nothing.

import {
  ASSET_PATH_PREFIX,
  HEARTBEAT_PATH,
  LIVE_PATH,
  PUBLISH_BASE_PATH,
  docKeyForRequest,
  isAssetName,
  isDocKey,
} from "../../../main/types/servicecue-publish.js";

/** One segment of a ServiceCue address: a name slug, an id, or `all-columns`. */
const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;

export interface Rejection {
  kind: "reject";
  status: 404 | 405;
  error: string;
  /** For a 405: the methods the path does answer. */
  allow?: string;
}

const notFound = (error = "Not found"): Rejection => ({ kind: "reject", status: 404, error });
const notAllowed = (allow: string): Rejection => ({ kind: "reject", status: 405, error: "Method not allowed", allow });

// ── The publisher's side: /_publish/v1/… ──────────────────────────────────────

/** Is this path in the publisher's area, and so behind the token? Everything under /_publish is, whatever follows. */
export function isPublishArea(pathname: string): boolean {
  return pathname === "/_publish" || pathname.startsWith("/_publish/");
}

export type PublishRoute =
  | { kind: "putDoc"; key: string }
  | { kind: "deleteDoc"; key: string }
  | { kind: "postFrame" }
  | { kind: "putAsset"; name: string }
  | { kind: "postHeartbeat" }
  | { kind: "putManifest" }
  | { kind: "getStatus" }
  | Rejection;

/** Which publish request this is. Called only after the token has been checked. */
export function routePublish(method: string, url: URL): PublishRoute {
  if (!url.pathname.startsWith(`${PUBLISH_BASE_PATH}/`)) return notFound();
  const parts = url.pathname.slice(PUBLISH_BASE_PATH.length).split("/");
  // parts[0] is "" — the path began with the slash that follows the base.

  if (parts.length === 3 && parts[1] === "doc") {
    const key = parts[2]!;
    if (method !== "PUT" && method !== "DELETE") return notAllowed("PUT, DELETE");
    if (!isDocKey(key)) return notFound("Not a doc key");
    return method === "PUT" ? { kind: "putDoc", key } : { kind: "deleteDoc", key };
  }
  if (parts.length === 3 && parts[1] === "asset") {
    const name = parts[2]!;
    if (method !== "PUT") return notAllowed("PUT");
    if (!isAssetName(name)) return notFound("Not an asset name");
    return { kind: "putAsset", name };
  }
  if (parts.length === 2) {
    switch (parts[1]) {
      case "frame":
        return method === "POST" ? { kind: "postFrame" } : notAllowed("POST");
      case "heartbeat":
        return method === "POST" ? { kind: "postHeartbeat" } : notAllowed("POST");
      case "manifest":
        return method === "PUT" ? { kind: "putManifest" } : notAllowed("PUT");
      case "status":
        return method === "GET" || method === "HEAD" ? { kind: "getStatus" } : notAllowed("GET, HEAD");
    }
  }
  return notFound();
}

// ── The public side ───────────────────────────────────────────────────────────
//
// The build's own files (scripts, styles, fonts, icons) are not here: wrangler.jsonc
// has the asset service answer them without the Worker, and one that reaches the Worker
// anyway is a path it does not name, so a 404.

export type PublicRoute =
  /** The viewer's document, whichever ServiceCue address asked for it. */
  | { kind: "viewer" }
  | { kind: "doc"; key: string }
  | { kind: "asset"; name: string }
  | { kind: "heartbeat" }
  | { kind: "live" }
  | Rejection;

/** `/servicecue`, or `/servicecue/<service type>/<layout>`, with at most one trailing slash. */
function isViewerPath(pathname: string): boolean {
  if (pathname === "/servicecue" || pathname === "/servicecue/") return true;
  if (!pathname.startsWith("/servicecue/")) return false;
  let rest = pathname.slice("/servicecue/".length);
  if (rest.endsWith("/")) rest = rest.slice(0, -1);
  const parts = rest.split("/");
  return parts.length === 2 && parts.every((p) => SEGMENT.test(p));
}

/** What a public path is, whatever the method. Null when it is nothing the Worker answers. */
function matchPublic(url: URL): Exclude<PublicRoute, Rejection> | null {
  const { pathname, search } = url;

  if (isViewerPath(pathname)) return { kind: "viewer" };

  if (pathname.startsWith(ASSET_PATH_PREFIX)) {
    const name = pathname.slice(ASSET_PATH_PREFIX.length);
    return isAssetName(name) ? { kind: "asset", name } : null;
  }

  if (pathname === HEARTBEAT_PATH) return search === "" ? { kind: "heartbeat" } : null;
  if (pathname === LIVE_PATH) return search === "" ? { kind: "live" } : null;

  const key = docKeyForRequest(pathname, search);
  return key === null ? null : { kind: "doc", key };
}

/**
 * Which public request this is. A path is recognised first and its method judged
 * second, so `POST /api/state` is a 405 (that path exists and does not take a POST)
 * and `POST /anything-else` is a 404 (nothing is there to take one).
 */
export function routePublic(method: string, url: URL): PublicRoute {
  const found = matchPublic(url);
  if (found === null) return notFound();
  if (found.kind === "live") return method === "GET" ? found : notAllowed("GET");
  return method === "GET" || method === "HEAD" ? found : notAllowed("GET, HEAD");
}
