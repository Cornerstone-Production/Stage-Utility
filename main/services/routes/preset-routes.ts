// preset-routes.ts — Slot presets
//
// Named, reusable slot arrangements.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error, readBody } from "./context.js";
import type { Slot } from "../../types/stage.js";
import { stageController } from "../stage-controller.js";

export async function presetRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
    // ── Presets ───────────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/presets") {
      const presets = await stageController.listPresets();
      json(res, presets);
      return;
    }

    if (method === "POST" && pathname === "/api/presets") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.name !== "string" || !(body.name as string).trim()) {
        error(res, "body.name (non-empty string) required");
        return;
      }
      // Optional displayId — defaults to primary display if omitted.
      const displayIdForPreset =
        typeof body.viewId === "string" && body.viewId
          ? body.viewId
          : typeof body.displayId === "string"
            ? body.displayId
            : "";
      const presets = await stageController.savePreset(displayIdForPreset, (body.name as string).trim());
      json(res, presets);
      return;
    }

    // POST /api/presets/import — add a preset from imported data (name + slots).
    if (method === "POST" && pathname === "/api/presets/import") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.name !== "string" || !(body.name as string).trim()) {
        error(res, "body.name (non-empty string) required");
        return;
      }
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const presets = await stageController.importPreset((body.name as string).trim(), body.slots as never[]);
      json(res, presets);
      return;
    }

    // POST /api/presets/reorder — { ids: string[] } (checked before :id routes)
    if (method === "POST" && pathname === "/api/presets/reorder") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.ids)) {
        error(res, "body.ids (array) required");
        return;
      }
      const presets = await stageController.reorderPresets(body.ids as string[]);
      json(res, presets);
      return;
    }

    // POST /api/presets/:id/apply
    const presetApplyMatch = pathname.match(/^\/api\/presets\/([^/]+)\/apply$/);
    if (method === "POST" && presetApplyMatch) {
      const id = presetApplyMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      // `viewId` is explicit and unambiguous. `displayId` is the legacy shape and
      // resolves through outputs, which is how an apply could land on a different
      // view than the caller was editing.
      const target =
        typeof body.viewId === "string" && body.viewId
          ? body.viewId
          : typeof body.displayId === "string"
            ? body.displayId
            : "";
      const { state, viewId } = await stageController.applyPreset(target, id);
      // The caller needs to know WHICH view was written, so it can read the right
      // slots back — and notice when that is not the view it was showing.
      json(res, { ...state, appliedViewId: viewId });
      return;
    }

    // PATCH /api/presets/:id — rename ({ name }) and/or overwrite ({ overwriteFromDisplayId })
    const presetPatchMatch = pathname.match(/^\/api\/presets\/([^/]+)$/);
    if (method === "PATCH" && presetPatchMatch) {
      const id = presetPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      let presets = await stageController.listPresets();
      if (typeof body.name === "string") presets = await stageController.renamePreset(id, body.name);
      // `slots` (explicit) overwrites with those directly (inline mic-slots objects);
      // otherwise overwrite from the given view/display's current slots.
      if (Array.isArray(body.slots)) {
        presets = await stageController.overwritePreset(id, "", body.slots as Slot[]);
      } else if (typeof body.overwriteFromDisplayId === "string") {
        presets = await stageController.overwritePreset(id, body.overwriteFromDisplayId);
      }
      json(res, presets);
      return;
    }

    // DELETE /api/presets/:id
    const presetDeleteMatch = pathname.match(/^\/api\/presets\/([^/]+)$/);
    if (method === "DELETE" && presetDeleteMatch) {
      const id = presetDeleteMatch[1];
      const presets = await stageController.deletePreset(id);
      json(res, presets);
      return;
    }

}
