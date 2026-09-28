// video-routes.ts — video feeds and their state.
//
// Every route must finish responding before it returns (see RouteCtx).

import { type RouteCtx, json, error, readBody } from "./context.js";
import { videoService } from "../video/video-service.js";

export async function videoRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

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
