// archive-routes.ts — the data archive: download, inspect, import.
//
// Separate from the config-snapshot routes in system-routes.ts, deliberately: the
// two bundles restore different things and must not be confused. `inspect` exists
// so the UI can state what an import will do before it does it — a count of
// "3 new, 41 already here" catches an archive from the wrong box while it is still
// a click away, where a confirmation dialog would be dismissed unread.

import { errorMessage } from "../errors.js";
import { buildArchive, importArchive, inspectArchive } from "../archive/archive-bundle.js";
import { BodyTooLargeError, error, json, readRawBody, type RouteCtx } from "./context.js";
import { zonedDateKey } from "../app-timezone.js";

/** Dated in the app's zone, not the server's clock — see view-routes.exportFilename. */
export function archiveExportFilename(at: number): string {
  return `stage-archive-${zonedDateKey(at)}.zip`;
}

export async function archiveRoutes({ req, res, pathname, method }: RouteCtx): Promise<void> {
  if (method === "GET" && pathname === "/api/archive/export") {
    const zip = await buildArchive();
    const fname = archiveExportFilename(Date.now());
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fname}"`,
      "Content-Length": String(zip.byteLength),
    });
    res.end(Buffer.from(zip));
    return;
  }

  // What would an import do? Counts only — nothing is written.
  if (method === "POST" && pathname === "/api/archive/inspect") {
    try {
      json(res, await inspectArchive(await readRawBody(req)));
    } catch (err) {
      // An oversized upload must keep its 413 — flattening every failure to 400
      // told the operator their archive was malformed when it was simply too big.
      if (err instanceof BodyTooLargeError) throw err;
      error(res, errorMessage(err));
    }
    return;
  }

  if (method === "POST" && pathname === "/api/archive/import") {
    try {
      const raw = await readRawBody(req);
      // The choice rides in a header because the body is the zip itself. It is one
      // mode for the whole import rather than a list of keys, which would grow past
      // the header limit once an archive holds a couple of hundred services.
      const m = req.headers["x-archive-mode"];
      const mode = m === "merge" || m === "replace" ? m : "skip";
      json(res, await importArchive(raw, { mode }));
    } catch (err) {
      // An oversized upload must keep its 413 — flattening every failure to 400
      // told the operator their archive was malformed when it was simply too big.
      if (err instanceof BodyTooLargeError) throw err;
      error(res, errorMessage(err));
    }
    return;
  }
}
