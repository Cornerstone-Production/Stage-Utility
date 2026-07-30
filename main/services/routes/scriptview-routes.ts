// scriptview-routes.ts — ScriptView
//
// The in-app ScriptViewer replacement: per-service-type rundown layouts.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error, readBody } from "./context.js";
import type { PatchFile, ScriptViewLayout, Slot } from "../../types/stage.js";
import { stageController } from "../stage-controller.js";
import { patchStore } from "../patch-store.js";
import { parseXlsx } from "../patch-xlsx.js";
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

    // One note category's colour, app-wide. "" clears it and the category falls back
    // to its suggestion — it does not hide the category, which PCO owns.
    if (method === "POST" && pathname === "/api/scriptview/category-color") {
      const body = await readBody(req) as Record<string, unknown>;
      const category = typeof body.category === "string" ? body.category : "";
      const color = typeof body.color === "string" ? body.color : "";
      try {
        json(res, await stageController.setCategoryColor(category, color));
      } catch (err) {
        error(res, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/note-categories") {
      const serviceTypeId = url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      json(res, await stageController.listScriptViewNoteCategories(serviceTypeId));
      return;
    }

    if (method === "GET" && pathname === "/api/scriptview/rundown") {
      const serviceTypeId = url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      const planId = url.searchParams.get("planId");
      json(res, await stageController.getScriptViewRundown(serviceTypeId, planId));
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
