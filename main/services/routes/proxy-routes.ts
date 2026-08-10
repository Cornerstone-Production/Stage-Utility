// proxy-routes.ts — Upstream media proxies
//
// Fetches media from PCO / ProPresenter / ProdCom on the display's behalf, so
// kiosks never need credentials or a route to those hosts.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { errorMessage } from "../errors.js";
import * as fs from "fs/promises";
import * as http from "http";

import { type RouteCtx, json, error } from "./context.js";
import { stageController } from "../stage-controller.js";
import { propresenterManager } from "../propresenter-service.js";
import { prodcomService } from "../prodcom-service.js";
import { THUMBNAIL_QUALITY as PROPRESENTER_THUMBNAIL_QUALITY } from "../propresenter-service.js";

// Small FIFO cache of ProPresenter slide thumbnails, keyed by the per-slide
// cache-bust token. Lets multiple displays showing the same slide share one
// upstream fetch instead of each hitting ProPresenter.
const thumbnailCache = new Map<string, { buf: Buffer; contentType: string }>();

type Thumbnail = { buf: Buffer; contentType: string } | { error: string };

/** GET one thumbnail from ProPresenter, resolving only once the body is complete.
 *  Never rejects — the caller turns an `error` into a 502. */
function fetchThumbnail(host: string, port: number, path: string): Promise<Thumbnail> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Thumbnail) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const upstream = http.get({ host, port, path, timeout: 5000 }, (up) => {
      if ((up.statusCode ?? 0) >= 400) {
        up.resume();
        done({ error: `HTTP ${up.statusCode}` });
        return;
      }
      const contentType = up.headers["content-type"] ?? "image/jpeg";
      const chunks: Buffer[] = [];
      up.on("data", (c: Buffer) => chunks.push(c));
      up.on("end", () => done({ buf: Buffer.concat(chunks), contentType }));
      up.on("error", (e) => done({ error: e.message }));
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", (e) => done({ error: e.message }));
  });
}

export async function proxyRoutes(c: RouteCtx): Promise<void> {
  const { res, pathname, url, method } = c;
    // ── PCO plan-attachment proxy (e.g. the stage plot) ──────────────────────
    // Streams the current plan's attachment matching ?match=<filename substring>,
    // proxied + cached so kiosk displays get a stable URL that always tracks the
    // CURRENT plan. Resolving by filename (not id) means the same layout object
    // shows the right file every week without re-pointing.
    if (method === "GET" && pathname === "/api/pco/attachment") {
      const match = url.searchParams.get("match") ?? "";
      try {
        const att = await stageController.findPlanAttachment(match);
        if (!att) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("No matching attachment on the current plan");
          return;
        }
        const { getAttachmentFile, mimeForExt } = await import("../pco-attachment-cache.js");
        const file = await getAttachmentFile(
          att.id,
          att.contentType,
          att.filename,
          async () => (await stageController.openPlanAttachment(att.id)).url,
        );
        if (!file) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Could not download attachment from Planning Center");
          return;
        }
        const data = await fs.readFile(file.path);
        res.writeHead(200, {
          "Content-Type": mimeForExt(file.ext),
          // Bytes are immutable per attachment id; cache briefly so a fresh plan
          // (new id, new URL) is picked up within a few minutes on the displays.
          "Cache-Control": "private, max-age=300",
        });
        res.end(data);
      } catch (err) {
        const msg = errorMessage(err);
        error(res, `Attachment error: ${msg}`, 500);
      }
      return;
    }

    // ── PCO photo proxy (replaces stage-photo:// in standalone mode) ──────
    if (method === "GET" && pathname === "/photos") {
      const photoUrl = url.searchParams.get("u");
      if (!photoUrl) {
        error(res, "u query param required");
        return;
      }
      try {
        const { getPhotoPath } = await import("../photo-cache.js");
        // `searchParams.get` has already decoded once. Decoding again turned the
        // avatar geometry's %23 into a literal '#', which a URL treats as the start
        // of a fragment — so PCO never saw the crop flag and returned a fit-inside
        // image instead of a crop. Invisible while the request was square (both give
        // the same result); it silently capped every non-square crop.
        const localPath = await getPhotoPath(photoUrl);
        if (!localPath) {
          res.writeHead(404);
          res.end("Photo not found");
          return;
        }
        const ext = localPath.split(".").pop()?.toLowerCase() ?? "jpg";
        const mime =
          ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
        const data = await fs.readFile(localPath);
        // Cache hard. The upstream URL is content-addressed by PCO — the path holds
        // the upload timestamp (`/person/<id>-<uploaded>/avatar.png`), so a new
        // photo is a new URL and therefore a new cache key. Without this header a
        // display re-downloaded every face on every load: nine photos at ~500 KB is
        // ~4.5 MB per reload, per screen, for images that had not changed.
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(data);
      } catch (err) {
        const msg = errorMessage(err);
        error(res, `Photo error: ${msg}`, 500);
      }
      return;
    }

    // ── ProPresenter slide preview proxy (stage display) ─────────────────────
    // Pipes the current slide's JPEG thumbnail from ProPresenter so the kiosk can
    // show it without reaching ProPresenter directly (works in prod; no CORS). The
    // ?k=<slidePreviewKey> param just cache-busts per slide — the source is the
    // service's current target. 21.3 returns real image/jpeg, so no decode.
    if (method === "GET" && pathname === "/api/propresenter/thumbnail") {
      // `?i=` selects which ProPresenter instance ("default"/absent = primary).
      const target = propresenterManager.getThumbnailTarget(url.searchParams.get("i"));
      if (!target) {
        res.writeHead(503);
        res.end("ProPresenter not connected / no active slide");
        return;
      }
      // Cache the fetched image so N displays showing the same slide don't each
      // hit ProPresenter. Key on the client's cache-bust token (`?k=` = the
      // slidePreviewKey, which changes per slide), else the slide's uuid:index.
      const cacheKey = url.searchParams.get("k") || `${target.uuid}:${target.index}`;
      const hit = thumbnailCache.get(cacheKey);
      if (hit) {
        res.writeHead(200, { "Content-Type": hit.contentType, "Cache-Control": "no-store" });
        res.end(hit.buf);
        return;
      }
      const path = `/v1/presentation/${target.uuid}/thumbnail/${target.index}?quality=${PROPRESENTER_THUMBNAIL_QUALITY}`;
      // AWAIT the upstream fetch before replying. This used to fire http.get and
      // return immediately, letting the callback answer later — which the route
      // dispatcher reads as "not handled" (nothing sent yet), so it fell through
      // to the 404 arm, ended the response, and the late writeHead then threw
      // ERR_HTTP_HEADERS_SENT from an event callback and killed the process.
      // Every route must finish responding before it returns; see RouteCtx.
      const fetched = await fetchThumbnail(target.host, target.port, path);
      if ("error" in fetched) {
        res.writeHead(502);
        res.end(`ProPresenter thumbnail error: ${fetched.error}`);
        return;
      }
      // Bound the cache (FIFO) — slide keys are short-lived, a few is plenty.
      if (thumbnailCache.size >= 16) {
        const firstKey = thumbnailCache.keys().next().value;
        if (firstKey !== undefined) thumbnailCache.delete(firstKey);
      }
      thumbnailCache.set(cacheKey, { buf: fetched.buf, contentType: fetched.contentType });
      res.writeHead(200, { "Content-Type": fetched.contentType, "Cache-Control": "no-store" });
      res.end(fetched.buf);
      return;
    }

    // ── ProdCom transcript backfill (recent lines for a freshly-loaded display) ──
    if (method === "GET" && pathname === "/api/prodcom/transcript") {
      json(res, prodcomService.getBuffer());
      return;
    }

}
