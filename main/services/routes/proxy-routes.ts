// proxy-routes.ts — Upstream media proxies
//
// Fetches media from PCO / ProPresenter / ProdCom on the display's behalf, so
// kiosks never need credentials or a route to those hosts.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

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
        const msg = err instanceof Error ? err.message : String(err);
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
        const localPath = await getPhotoPath(decodeURIComponent(photoUrl));
        if (!localPath) {
          res.writeHead(404);
          res.end("Photo not found");
          return;
        }
        const ext = localPath.split(".").pop()?.toLowerCase() ?? "jpg";
        const mime =
          ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
        const data = await fs.readFile(localPath);
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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
      const upstream = http.get({ host: target.host, port: target.port, path, timeout: 5000 }, (up) => {
        if ((up.statusCode ?? 0) >= 400) {
          up.resume();
          res.writeHead(502);
          res.end(`ProPresenter thumbnail HTTP ${up.statusCode}`);
          return;
        }
        const contentType = up.headers["content-type"] ?? "image/jpeg";
        const chunks: Buffer[] = [];
        up.on("data", (c: Buffer) => chunks.push(c));
        up.on("end", () => {
          const buf = Buffer.concat(chunks);
          // Bound the cache (FIFO) — slide keys are short-lived, a few is plenty.
          if (thumbnailCache.size >= 16) {
            const firstKey = thumbnailCache.keys().next().value;
            if (firstKey !== undefined) thumbnailCache.delete(firstKey);
          }
          thumbnailCache.set(cacheKey, { buf, contentType });
          res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
          res.end(buf);
        });
      });
      upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
      upstream.on("error", (e) => {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(`ProPresenter thumbnail error: ${e.message}`);
        }
      });
      return;
    }

    // ── ProdCom transcript backfill (recent lines for a freshly-loaded display) ──
    if (method === "GET" && pathname === "/api/prodcom/transcript") {
      json(res, prodcomService.getBuffer());
      return;
    }

}
