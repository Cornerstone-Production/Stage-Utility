// plan-routes.ts — exporting one service type's setup.
//
// Two reads and no writes. The import side is POST /api/views/import in
// view-routes.ts: a plan file IS a view bundle, and splitting the import in two
// would be two code paths merging the same file.

import { buildPlanBundle, planExportPreview } from "../plan-export.js";
import { errorMessage } from "../errors.js";
import { zonedDateKey } from "../app-timezone.js";
import { filenameSlug } from "./view-routes.js";
import { type RouteCtx, json, error } from "./context.js";

/** `sunday-am-2026-09-08.stage-plan.json`. Dated in the APP's zone, never the
 *  server's clock — a UTC box names a file exported at 22:30 in Chicago for the
 *  next day. */
export function planExportFilename(serviceTypeName: string, now: Date): string {
  const slug = filenameSlug(serviceTypeName);
  return `${slug ? `${slug}-` : ""}${zonedDateKey(now.getTime())}.stage-plan.json`;
}

/** `1`/`0` (or `true`/`false`) with a default, and nothing else — a query the
 *  caller got wrong is a 400, not a silent fallback to a section they did not
 *  ask for. */
function flag(url: URL, name: string, fallback: boolean): boolean | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

/** Both routes answer 400 the same way: an unknown type and an empty type are
 *  the operator's query, not a server fault. */
function refuse(res: RouteCtx["res"], err: unknown): void {
  const msg = errorMessage(err);
  error(res, msg, /unknown service type|nothing to export/.test(msg) ? 400 : 500);
}

export async function planRoutes(c: RouteCtx): Promise<void> {
  const { res, pathname, method, url } = c;

  // GET /api/plans/export/preview?serviceTypeId= — what the export dialog counts
  // before an operator commits to a download. Must precede the /export matcher.
  if (method === "GET" && pathname === "/api/plans/export/preview") {
    const serviceTypeId = url.searchParams.get("serviceTypeId");
    if (!serviceTypeId) {
      error(res, "serviceTypeId is required");
      return;
    }
    try {
      json(res, await planExportPreview(serviceTypeId));
    } catch (err) {
      refuse(res, err);
    }
    return;
  }

  // GET /api/plans/export?serviceTypeId=&slots=type|all&patch=1|0&presets=1|0
  if (method === "GET" && pathname === "/api/plans/export") {
    const serviceTypeId = url.searchParams.get("serviceTypeId");
    if (!serviceTypeId) {
      error(res, "serviceTypeId is required");
      return;
    }
    const slots = url.searchParams.get("slots") ?? "type";
    if (slots !== "type" && slots !== "all") {
      error(res, `slots must be "type" or "all", not "${slots}"`);
      return;
    }
    const patch = flag(url, "patch", true);
    const presets = flag(url, "presets", false);
    if (patch === null || presets === null) {
      error(res, "patch and presets must be 1 or 0");
      return;
    }
    try {
      const bundle = await buildPlanBundle({ serviceTypeId, slots, patch, presets });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${planExportFilename(bundle.plan!.serviceTypeName, new Date())}"`,
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(bundle, null, 2));
    } catch (err) {
      refuse(res, err);
    }
    return;
  }
}
