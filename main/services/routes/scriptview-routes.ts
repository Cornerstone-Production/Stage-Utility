// scriptview-routes.ts — ScriptView
//
// The in-app ScriptViewer replacement: per-service-type rundown layouts.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error, readBody } from "./context.js";
import { errorMessage } from "../errors.js";
import type { PatchFile, ScriptViewLayout, Slot } from "../../types/stage.js";
import type { CategoryRole } from "../../types/scriptview-roles.js";
import { stageController } from "../stage-controller.js";
import { patchStore } from "../patch-store.js";
import { parseXlsx } from "../patch-xlsx.js";
import { exportFilename, exportRows } from "../patch-export.js";
import { toCsv } from "../patch-export-csv.js";
import { toXlsx } from "../patch-export-xlsx.js";
import { broadcast } from "../broadcaster.js";

export async function scriptviewRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, url, method } = c;
    // ── ScriptView (in-app ScriptViewer replacement) ─────────────────────────
    if (method === "GET" && pathname === "/api/scriptview/layouts") {
      json(res, await stageController.listScriptViewLayouts());
      return;
    }

    if (method === "POST" && pathname === "/api/scriptview/layouts") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.layouts)) {
        error(res, "body.layouts (array) required");
        return;
      }
      json(res, await stageController.saveScriptViewLayouts(body.layouts as ScriptViewLayout[]));
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/config") {
      json(res, await stageController.getScriptViewConfig());
      return;
    }

    if (method === "POST" && pathname === "/api/scriptview/config") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.serviceTypeIds)) {
        error(res, "body.serviceTypeIds (array) required");
        return;
      }
      json(res, await stageController.setScriptViewConfig(body.serviceTypeIds.map(String)));
      return;
    }

    // Download one sheet as a file. Registered BEFORE "/api/patch" so the more
    // specific path wins; a plain navigation hits this, so the browser handles the
    // download and honours the Content-Disposition filename.
    if (method === "GET" && pathname === "/api/patch/export") {
      const sheetId = url.searchParams.get("sheetId") ?? "";
      const variantId = url.searchParams.get("variantId") || null;
      const format = url.searchParams.get("format") ?? "csv";
      const includeUnused = url.searchParams.get("includeUnused") === "1";

      const file = await patchStore.load();
      const sheet = file.sheets.find((s) => s.id === sheetId);
      // 400 naming what was not found, not a 500: the request was well-formed, it
      // just referenced something that is gone.
      if (!sheet) {
        error(res, `No patch sheet with id "${sheetId}"`);
        return;
      }
      const variant = variantId ? sheet.variants.find((v) => v.id === variantId) : null;
      if (variantId && !variant) {
        error(res, `No variant with id "${variantId}" on sheet "${sheet.name}"`);
        return;
      }
      if (format !== "csv" && format !== "xlsx") {
        error(res, `Unsupported export format "${format}"`);
        return;
      }

      // "This week" is a resolution, not a variant: default -> standing variant
      // -> per-plan variant -> that plan's tweaks. Without planId the tab had
      // nothing to send and silently exported the default patch.
      const planId = url.searchParams.get("planId") || null;
      const serviceTypeId = url.searchParams.get("serviceTypeId") || null;
      const plan = planId ? { planId, serviceTypeId } : undefined;

      const rows = exportRows(sheet, variantId, { includeUnused, plan });
      // Name it for what it is. A week export merges tweaks that belong to one
      // plan, so labelling it with the underlying variant would put a file on
      // the rack claiming to be the standing patch.
      const label = plan ? "this-week" : (variant?.name ?? null);
      const filename = exportFilename(sheet.name, label, format);
      if (format === "xlsx") {
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        });
        res.end(await toXlsx(rows));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      res.end(toCsv(rows));
      return;
    }

    // Stage patch sheet — full file (devices + default endpoints + variants +
    // assignments). Editor GETs on mount then listens for the change broadcast.
    if (method === "GET" && pathname === "/api/patch") {
      json(res, await patchStore.load());
      return;
    }

    if (method === "POST" && pathname === "/api/patch") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const file = body.file as PatchFile | undefined;
      if (!file || typeof file !== "object" || !Array.isArray(file.sheets)) {
        error(res, "body.file (PatchFile) required");
        return;
      }
      const saved = await patchStore.save(file);
      broadcast("patch:updated", saved); // change-driven; editor + /patch live-update
      json(res, saved);
      return;
    }

    // Parse an uploaded .xlsx (base64) → { headers, rows } for the patch importer.
    if (method === "POST" && pathname === "/api/patch/parse-xlsx") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const b64 = typeof body.xlsx === "string" ? body.xlsx : "";
      if (!b64) {
        error(res, "body.xlsx (base64) required");
        return;
      }
      try {
        json(res, await parseXlsx(b64));
      } catch {
        error(res, "Couldn't parse that .xlsx file");
      }
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/roles") {
      json(res, await stageController.listScriptViewRoles());
      return;
    }

    if (method === "POST" && pathname === "/api/scriptview/roles") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.roles)) {
        error(res, "body.roles (array) required");
        return;
      }
      json(res, await stageController.saveScriptViewRoles(body.roles as CategoryRole[]));
      return;
    }

    // Adds a role for any category this service type defines that no role covers yet.
    // Only ever adds — never merges, never removes.
    if (method === "POST" && pathname === "/api/scriptview/roles/seed") {
      const body = await readBody(req) as Record<string, unknown>;
      const serviceTypeId = typeof body.serviceTypeId === "string" ? body.serviceTypeId : "";
      if (!serviceTypeId) {
        error(res, "body.serviceTypeId (string) required");
        return;
      }
      json(res, await stageController.seedScriptViewRoles(serviceTypeId));
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/note-categories") {
      const serviceTypeId = url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      try {
        json(res, await stageController.listScriptViewNoteCategories(serviceTypeId));
      } catch (err) {
      // 502, not 500: the request was well-formed, so reaching Planning Center
      // is the only way this fails, and a 500 tells the operator this app broke
      // when the upstream is down. The calendar routes make the same argument
      // the other way round: a 400 would blame the caller. Without a try this
      // reached the dispatcher's generic arm, which is 500 by design because a
      // status is opt-in.
        error(res, errorMessage(err), 502);
      }
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/rundown") {
      const serviceTypeId = url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      const planId = url.searchParams.get("planId");
      try {
        json(res, await stageController.getScriptViewRundown(serviceTypeId, planId));
      } catch (err) {
        error(res, errorMessage(err), 502);
      }
      return;
    }

    if (method === "POST" && pathname === "/api/service-type") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.id !== "string") {
        error(res, "body.id (string) required");
        return;
      }
      const state = await stageController.setServiceType(body.id);
      json(res, state);
      return;
    }

    if (method === "POST" && pathname === "/api/plan") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.id !== "string") {
        error(res, "body.id (string) required");
        return;
      }
      const state = await stageController.setPlan(body.id);
      json(res, state);
      return;
    }

    if (method === "POST" && pathname === "/api/plan/next") {
      const state = await stageController.selectNextPlan();
      json(res, state);
      return;
    }

    if (method === "POST" && pathname === "/api/plan/mode") {
      const body = await readBody(req) as Record<string, unknown>;
      if (body.mode !== "auto" && body.mode !== "manual") {
        error(res, 'body.mode must be "auto" or "manual"');
        return;
      }
      const state = await stageController.setPlanMode(body.mode as "auto" | "manual");
      json(res, state);
      return;
    }

    if (method === "POST" && pathname === "/api/refresh") {
      const state = await stageController.refresh();
      json(res, state);
      return;
    }

    // PCO Services Live timer controls (next / previous item).
    if (method === "POST" && (pathname === "/api/live/next" || pathname === "/api/live/previous")) {
      const direction = pathname.endsWith("/next") ? "next" : "previous";
      await stageController.controlLive(direction);
      json(res, { ok: true });
      return;
    }

    if (method === "POST" && pathname === "/api/slots") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      // Optional displayId — defaults to primary display if omitted.
      const displayId = typeof body.displayId === "string" ? body.displayId : "";
      const state = await stageController.setSlots(displayId, body.slots as Slot[]);
      json(res, state);
      return;
    }

}
