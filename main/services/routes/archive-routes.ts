// archive-routes.ts — the data archive: download, inspect, import.
//
// Separate from the config-snapshot routes in system-routes.ts, deliberately: the
// two bundles restore different things and must not be confused. `inspect` exists
// so the UI can state what an import will do before it does it — a count of
// "3 new, 41 already here" catches an archive from the wrong box while it is still
// a click away, where a confirmation dialog would be dismissed unread.

import { errorMessage } from "../errors.js";
import { buildArchive, importArchive, inspectArchive } from "../archive/archive-bundle.js";
import { StoreReadError } from "../data-store.js";
import { ServiceNotSavedError } from "../history-edit.js";
import { BodyTooLargeError, error, json, readRawBody, type RouteCtx } from "./context.js";
import { zonedDateKey } from "../app-timezone.js";

/** Dated in the app's zone, not the server's clock — see view-routes.exportFilename. */
export function archiveExportFilename(at: number): string {
  return `stage-archive-${zonedDateKey(at)}.zip`;
}

/**
 * An uploaded archive that will not import is a 400 naming why. Not every
 * failure is the upload's: an oversized one keeps its 413 (flattened to 400, it
 * told the operator their archive was malformed when it was simply too big),
 * a history file this box cannot read keeps its 503, and a service a recorder
 * has not saved yet keeps its 409.
 */
function failUpload(res: RouteCtx["res"], err: unknown): void {
  if (err instanceof BodyTooLargeError || err instanceof StoreReadError || err instanceof ServiceNotSavedError) throw err;
  error(res, errorMessage(err));
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
      failUpload(res, err);
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
      failUpload(res, err);
    }
    return;
  }
}
