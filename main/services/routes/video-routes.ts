// video-routes.ts — video feeds and their state.
//
// Every route must finish responding before it returns (see RouteCtx).

import { type RouteCtx, json, error, readBody, queryFlag, MAX_CONFIG_BODY_BYTES } from "./context.js";
import { datedExportFilename } from "../export-filename.js";
import { isCrossOrigin } from "../http-origin.js";
import { scrub } from "../scrub.js";
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
  // The latest camera checks; the same snapshot `video:probe` pushes.
  if (method === "GET" && pathname === "/api/video/probe") {
    json(res, videoService.probeState());
    return;
  }
  if (method === "GET" && pathname === "/api/video/feeds") {
    json(res, { feeds: (await videoService.state()).feeds });
    return;
  }
  // GET /api/video/export?feeds=a,b&ports=1&passwords=1 — the feeds as one file.
  if (method === "GET" && pathname === "/api/video/export") {
    const ports = queryFlag(url, "ports", false);
    const passwords = queryFlag(url, "passwords", false);
    if (ports === null || passwords === null) {
      error(res, `${ports === null ? "ports" : "passwords"} must be 1, 0, true or false.`);
      return;
    }
    // With passwords this GET answers live secrets, like the push address
    // route below: a browser cross-site request is refused the same way.
    if (passwords && isCrossOrigin(req.headers.origin, req.headers.host)) {
      error(res, "cross-origin request rejected", 403);
      return;
    }
    const r = await videoService.exportBundle(url.searchParams.get("feeds"), ports, passwords);
    if (!r.ok) {
      error(res, r.error);
      return;
    }
    // The count and the two flags only; never a password, and no feed name.
    const n = r.bundle.feeds.length;
    const summary = `exported ${n} feed${n === 1 ? "" : "s"}${passwords ? ", with passwords" : ""}${ports ? ", with relay ports" : ""}`;
    console.log(`[video-export] ${scrub(summary)}`);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${datedExportFilename("stage-utility-video-feeds", "", new Date())}"`,
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(r.bundle, null, 2));
    return;
  }
  // The file's own size is small, but it is the config ceiling every import
  // route here shares, and a file can be edited by hand.
  if (method === "POST" && pathname === "/api/video/import/preview") {
    const r = await videoService.previewImport(await readBody(req, MAX_CONFIG_BODY_BYTES));
    if (r.ok) json(res, r.preview);
    else error(res, r.error);
    return;
  }
  if (method === "POST" && pathname === "/api/video/import") {
    const r = await videoService.importFeeds(await readBody(req, MAX_CONFIG_BODY_BYTES));
    if (r.ok) json(res, r.report);
    else error(res, r.error);
    return;
  }
  if (method === "PATCH" && pathname === "/api/video/ports") {
    const r = await videoService.setPorts(await readBody(req));
    if (r.ok) json(res, { ports: r.ports });
    else error(res, r.error);
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
    // This route answers a live secret (the feed's own publish
    // password), unlike every other GET here — a browser cross-site request
    // must be refused the same way a mutating one already is
    // (remote-server.ts's own gate only covers POST/PATCH/PUT/DELETE; reads
    // stay open by design for LAN peers, which this one route cannot be).
    if (isCrossOrigin(req.headers.origin, req.headers.host)) {
      error(res, "cross-origin request rejected", 403);
      return;
    }
    // The editor's protocol segmented control previews another
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
