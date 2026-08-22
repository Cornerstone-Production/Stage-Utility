// signage-routes.ts — the media library, and the assets a display fetches.
//
// Two things here are unlike every other route module.
//
// The upload is a RAW STREAM, not a JSON body. readBody would parse it and
// readRawBody would hold a 200 MB video in memory twice; signage-upload streams
// it to disk instead. That is also why the metadata travels in headers — the
// body is the file.
//
// The asset route serves bytes off disk to anything on the LAN. The filename is
// checked before any lookup, and every response carries nosniff plus a sandbox
// CSP so a file opened directly in a tab is inert whatever it turns out to hold.

import { errorMessage } from "../errors.js";
import {
  addMedia,
  clampMeasured,
  deleteMedia,
  listMedia,
  readMediaFile,
  renameMedia,
} from "../signage-media-store.js";
import { streamUploadToMedia, UploadTooLargeError } from "../signage-upload.js";
import { error, json, readBody, type RouteCtx } from "./context.js";

/** The longest a media name may be after cleaning. Long enough for a real
 *  filename, short enough that a list stays readable. */
const MAX_NAME = 200;

/**
 * Clean operator-supplied text arriving in a header.
 *
 * Control characters are stripped rather than escaped: this value ends up in a
 * JSON response, in the UI and in log lines, and a CRLF surviving into a log
 * line is how a forged entry reaches the LAN-visible /log page.
 */
function cleanName(raw: string | undefined, fallback: string): string {
  const s = (raw ?? "")
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
  return s || fallback;
}

function header(c: RouteCtx, name: string): string | undefined {
  const v = c.req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** A number from a header, or undefined when absent — clampMeasured decides
 *  whether undefined is acceptable for this mime, so the rejection message is
 *  written in one place. */
function numHeader(c: RouteCtx, name: string): number | undefined {
  const raw = header(c, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  return Number(raw);
}

export async function signageRoutes(c: RouteCtx): Promise<void> {
  // ── Assets ────────────────────────────────────────────────────────────────
  if (c.pathname.startsWith("/signage-media/") && c.method === "GET") {
    // decodeURIComponent so an encoded traversal ("..%2F") is rejected by the
    // name check rather than slipping past it as a literal string.
    let file: string;
    try {
      file = decodeURIComponent(c.pathname.slice("/signage-media/".length));
    } catch {
      return error(c.res, "not found", 404);
    }
    const found = await readMediaFile(file);
    if (!found) return error(c.res, "not found", 404);
    c.res.writeHead(200, {
      "Content-Type": found.mime,
      "Content-Length": String(found.data.length),
      // Safe precisely because the name IS the hash: the bytes at a name can
      // never change, so there is nothing to revalidate.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    c.res.end(found.data);
    return;
  }

  // ── Media collection ──────────────────────────────────────────────────────
  if (c.pathname === "/api/signage/media") {
    if (c.method === "GET") return json(c.res, { media: await listMedia() });

    if (c.method === "POST") {
      const mime = (header(c, "content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!mime) return error(c.res, "a content-type is required", 400);

      let stored: { file: string; bytes: number; existed: boolean };
      try {
        // Streams to disk. Anything wrong with the type or the size is refused
        // here, before a record exists.
        stored = await streamUploadToMedia(c.req, mime);
      } catch (err) {
        if (err instanceof UploadTooLargeError) return error(c.res, err.message, 413);
        return error(c.res, errorMessage(err), 400);
      }

      let measured: { w: number; h: number; durationMs?: number };
      try {
        measured = clampMeasured({
          w: numHeader(c, "x-signage-w"),
          h: numHeader(c, "x-signage-h"),
          durationMs: numHeader(c, "x-signage-duration-ms"),
          mime,
        });
      } catch (err) {
        // The FILE is deliberately left on disk: it is content-addressed and
        // unreferenced, so the next prune reaps it. Unlinking here would delete
        // bytes a different, valid record might already point at.
        return error(c.res, errorMessage(err), 400);
      }

      const result = await addMedia({
        file: stored.file,
        name: cleanName(header(c, "x-signage-name"), stored.file),
        mime,
        bytes: stored.bytes,
        ...measured,
      });
      return json(c.res, { media: result.media, deduped: result.deduped });
    }
  }

  // ── One media item ────────────────────────────────────────────────────────
  const mediaItem = /^\/api\/signage\/media\/([^/]+)$/.exec(c.pathname);
  if (mediaItem) {
    const id = decodeURIComponent(mediaItem[1]);

    if (c.method === "PATCH") {
      const body = (await readBody(c.req)) as { name?: unknown };
      if (typeof body?.name !== "string") return error(c.res, "a name is required", 400);
      const media = await renameMedia(id, cleanName(body.name, id));
      if (!media) return error(c.res, "no such media", 404);
      return json(c.res, { media });
    }

    if (c.method === "DELETE") {
      const media = await deleteMedia(id);
      if (!media) return error(c.res, "no such media", 404);
      return json(c.res, { media });
    }
  }
}
