// archive-routes.ts — the data archive: download, inspect, import.
//
// Separate from the config-snapshot routes in system-routes.ts, deliberately: the
// two bundles restore different things and must not be confused. `inspect` exists
// so the UI can state what an import will do before it does it — a count of
// "3 new, 41 already here" catches an archive from the wrong box while it is still
// a click away, where a confirmation dialog would be dismissed unread.

import { buildArchive, importArchive, inspectArchive } from "../archive/archive-bundle.js";
import { error, json, readRawBody, type RouteCtx } from "./context.js";

export async function archiveRoutes({ req, res, pathname, method }: RouteCtx): Promise<void> {
  if (method === "GET" && pathname === "/api/archive/export") {
    const zip = await buildArchive();
    const fname = `stage-archive-${new Date().toISOString().slice(0, 10)}.zip`;
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
      error(res, err instanceof Error ? err.message : String(err));
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
      error(res, err instanceof Error ? err.message : String(err));
    }
    return;
  }
}
