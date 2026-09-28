// video-routes.ts — video feeds and their state.
//
// Every route must finish responding before it returns (see RouteCtx).

import { type RouteCtx, json, error, readBody } from "./context.js";
import { isCrossOrigin } from "../http-origin.js";
import { videoService } from "../video/video-service.js";
import { PUSH_PROTOCOLS, type PushProtocol } from "../../types/video.js";

function isPushProtocol(v: string | null): v is PushProtocol {
  return v !== null && (PUSH_PROTOCOLS as readonly string[]).includes(v);
}

export async function videoRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, url, method } = c;

  if (method === "GET" && pathname === "/api/video/state") {
    json(res, await videoService.state());
    return;
  }
  if (method === "GET" && pathname === "/api/video/feeds") {
    json(res, { feeds: (await videoService.state()).feeds });
    return;
  }
  if (method === "POST" && pathname === "/api/video/feeds") {
    const r = await videoService.addFeed(await readBody(req));
    if (r.ok) json(res, { feed: r.feed }, 201);
    else error(res, r.error);
    return;
  }

  const usage = pathname.match(/^\/api\/video\/feeds\/([^/]+)\/usage$/);
  if (method === "GET" && usage) {
    json(res, { layouts: await videoService.usage(decodeURIComponent(usage[1])) });
    return;
  }

  const push = pathname.match(/^\/api\/video\/feeds\/([^/]+)\/push$/);
  if (method === "GET" && push) {
    // R14f: this route answers a live secret (the feed's own publish
    // password), unlike every other GET here — a browser cross-site request
    // must be refused the same way a mutating one already is
    // (remote-server.ts's own gate only covers POST/PATCH/PUT/DELETE; reads
    // stay open by design for LAN peers, which this one route cannot be).
    if (isCrossOrigin(req.headers.origin, req.headers.host)) {
      error(res, "cross-origin request rejected", 403);
      return;
    }
    // R14g: the editor's protocol segmented control previews another
    // protocol's address (same feed, same password) before Save — an
    // invalid or absent value just falls back to the feed's own saved one.
    const protocolParam = url.searchParams.get("protocol");
    const protocol = isPushProtocol(protocolParam) ? protocolParam : undefined;
    const address = await videoService.pushAddress(decodeURIComponent(push[1]), protocol);
    if (address) json(res, address);
    else error(res, "No such push feed", 404);
    return;
  }

  const newPassword = pathname.match(/^\/api\/video\/feeds\/([^/]+)\/push\/new-password$/);
  if (method === "POST" && newPassword) {
    const address = await videoService.newPushPassword(decodeURIComponent(newPassword[1]));
    if (address) json(res, address);
    else error(res, "No such push feed", 404);
    return;
  }

  const one = pathname.match(/^\/api\/video\/feeds\/([^/]+)$/);
  if (one && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(one[1]);
    if (method === "DELETE") {
      if (await videoService.removeFeed(id)) json(res, { ok: true });
      else error(res, "No such feed", 404);
      return;
    }
    const r = await videoService.updateFeed(id, await readBody(req));
    if (r.ok) json(res, { feed: r.feed });
    else if (r.error === "not-found") error(res, "No such feed", 404);
    else error(res, r.error);
    return;
  }
}
