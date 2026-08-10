// view-routes.ts — Displays, views, layouts, outputs
//
// The content model: displays (legacy), Views, reusable layout templates and
// groups, and the Outputs that route a View to a screen.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import {
  listLayoutTemplates,
  saveLayoutTemplate,
  updateLayoutTemplate,
  deleteLayoutTemplate,
  listLayoutGroups,
  saveLayoutGroup,
  deleteLayoutGroup,
} from "../layout-library.js";
import { errorMessage } from "../errors.js";
import { type RouteCtx, json, error, readBody, isDisplayKind } from "./context.js";
import type { ViewKind, LayoutDTO, LayoutObject, Slot, SlotsLayout } from "../../types/stage.js";
import { LayoutConflictError, stageController } from "../stage-controller.js";

/**
 * The minimum shape a layout must have to be stored and rendered.
 *
 * This used to be `typeof layout === "object"` followed by a cast, which let any
 * object through. Two consequences, both real: the renderer reads
 * `canvas.width` unguarded, so a layout without one crashed the display it was
 * saved to; and `objects.length` went straight into a log line, so an `objects`
 * of `{ length: "…\n[stage-controller] …" }` forged entries on the LAN-visible
 * /log page. Validating the shape closes both at the door.
 *
 * Deliberately shallow — it checks what the renderer and the log actually
 * require, not every optional field of a LayoutObject.
 */
function isLayoutShape(v: unknown): v is LayoutDTO {
  if (!v || typeof v !== "object") return false;
  const l = v as { objects?: unknown; canvas?: unknown };
  if (!Array.isArray(l.objects)) return false;
  if (!l.canvas || typeof l.canvas !== "object") return false;
  const c = l.canvas as { width?: unknown; height?: unknown };
  return (
    typeof c.width === "number" && Number.isFinite(c.width) &&
    typeof c.height === "number" && Number.isFinite(c.height)
  );
}

export async function viewRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
    if (method === "GET" && pathname === "/api/displays") {
      json(res, stageController.getDisplays());
      return;
    }

    // The legacy write API (POST /api/displays, PATCH|DELETE /api/displays/:id)
    // is gone — Views and Outputs replaced it and nothing called it. GET
    // /api/displays and /api/displays/refresh stay: the first is the DisplayInfo
    // compat shim, the second is what the Companion module uses to reload kiosks.

    // ── Views (content definitions) ───────────────────────────────────────
    if (method === "GET" && pathname === "/api/views") {
      json(res, stageController.getViews());
      return;
    }

    if (method === "POST" && pathname === "/api/views") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const kind = isDisplayKind(body.kind) ? body.kind : "slots";
      const state = await stageController.createView(name ?? "", kind);
      json(res, state, 201);
      return;
    }

    // POST /api/views/reorder — { ids: string[] }
    if (method === "POST" && pathname === "/api/views/reorder") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.ids)) {
        error(res, "body.ids (string[]) required");
        return;
      }
      const state = await stageController.reorderViews(body.ids as string[]);
      json(res, state);
      return;
    }

    // POST /api/views/resolve-slots — { slots } → resolved Slot[] (no persist).
    // Powers the Views page live draft preview: resolves in-progress edits against
    // the current team + device state so the preview matches the kiosk, without
    // saving. Must precede the /api/views/:id/slots matcher.
    if (method === "POST" && pathname === "/api/views/resolve-slots") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      json(res, stageController.resolveSlotsPreview(body.slots as Slot[]));
      return;
    }

    // POST /api/views/:id/slots — { slots }
    const viewSlotsMatch = pathname.match(/^\/api\/views\/([^/]+)\/slots$/);
    if (method === "POST" && viewSlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const state = await stageController.setViewSlots(viewSlotsMatch[1], body.slots as Slot[]);
      json(res, state);
      return;
    }

    // POST /api/layout-objects/:objectId/slots — { slots } (inline mic-slots grid)
    const objectSlotsMatch = pathname.match(/^\/api\/layout-objects\/([^/]+)\/slots$/);
    if (method === "POST" && objectSlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const state = await stageController.setLayoutObjectSlots(objectSlotsMatch[1], body.slots as Slot[]);
      json(res, state);
      return;
    }

    // POST /api/views/:id/duplicate — { name? }
    const viewDuplicateMatch = pathname.match(/^\/api\/views\/([^/]+)\/duplicate$/);
    if (method === "POST" && viewDuplicateMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const state = await stageController.duplicateView(viewDuplicateMatch[1], name);
      json(res, state, 201);
      return;
    }

    // POST /api/views/:id/copy-slots — { fromViewId }
    const viewCopySlotsMatch = pathname.match(/^\/api\/views\/([^/]+)\/copy-slots$/);
    if (method === "POST" && viewCopySlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.fromViewId !== "string") {
        error(res, "body.fromViewId (string) required");
        return;
      }
      const state = await stageController.copyViewSlots(viewCopySlotsMatch[1], body.fromViewId);
      json(res, state);
      return;
    }

    // PATCH /api/views/:id — { name? } and/or { kind? } and/or { ndiSource? } and/or { layout? }
    const viewPatchMatch = pathname.match(/^\/api\/views\/([^/]+)$/);
    if (method === "PATCH" && viewPatchMatch) {
      const id = viewPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const hasName = typeof body.name === "string";
      const hasKind = isDisplayKind(body.kind);
      const hasNdiSource = "ndiSource" in body
        && (typeof body.ndiSource === "string" || body.ndiSource === null);
      const hasLayout = "layout" in body && isLayoutShape(body.layout);
      // Present but malformed is a client error, not "no layout given" — falling
      // through would report the generic "one of these fields is required".
      if ("layout" in body && !hasLayout) {
        error(res, "body.layout must be an object with an objects array and a canvas of numeric width and height");
        return;
      }
      const hasSlotsLayout = "slotsLayout" in body
        && (body.slotsLayout === null || typeof body.slotsLayout === "object");
      const hasShowLiveControls = typeof body.showLiveControls === "boolean";
      if (!hasName && !hasKind && !hasNdiSource && !hasLayout && !hasSlotsLayout && !hasShowLiveControls) {
        error(res, "body.name (string), body.kind, body.ndiSource (string|null), body.layout (object), body.slotsLayout (object|null), or body.showLiveControls (boolean) required");
        return;
      }
      let state = stageController.getState();
      if (hasName) state = await stageController.renameView(id, body.name as string);
      if (hasKind) state = await stageController.setViewKind(id, body.kind as ViewKind);
      if (hasNdiSource) state = await stageController.setViewNdiSource(id, body.ndiSource as string | null);
      if (hasLayout) {
        // layoutRev is the revision the editor opened. Present = "only save if
        // nobody else has since"; absent = an explicit overwrite.
        const expectedRev = typeof body.layoutRev === "number" ? body.layoutRev : undefined;
        try {
          state = await stageController.setViewLayout(id, body.layout as LayoutDTO, expectedRev);
        } catch (err) {
          if (err instanceof LayoutConflictError) {
            // 409, not 500 — the request was well-formed and the caller has a
            // real choice to make. currentRev lets them retry as an overwrite.
            json(res, { error: err.message, code: err.code, currentRev: err.currentRev }, 409);
            return;
          }
          throw err;
        }
      }
      if (hasSlotsLayout) state = await stageController.setViewSlotsLayout(id, body.slotsLayout as SlotsLayout | null);
      if (hasShowLiveControls) state = await stageController.setViewShowLiveControls(id, body.showLiveControls as boolean);
      json(res, state);
      return;
    }

    // DELETE /api/views/:id
    const viewDeleteMatch = pathname.match(/^\/api\/views\/([^/]+)$/);
    if (method === "DELETE" && viewDeleteMatch) {
      const state = await stageController.deleteView(viewDeleteMatch[1]);
      json(res, state);
      return;
    }

    // ── Layout templates (reusable custom layouts) ────────────────────────
    if (method === "GET" && pathname === "/api/layout-templates") {
      json(res, await listLayoutTemplates());
      return;
    }

    if (method === "POST" && pathname === "/api/layout-templates") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.name !== "string" || !isLayoutShape(body.layout)) {
        error(res, "body.name (string) and body.layout (objects array + numeric canvas) required");
        return;
      }
      // A template is instantiated into a view later, so a malformed one crashes
      // a display just as surely — validated at the same door.
      const list = await saveLayoutTemplate(body.name, body.layout);
      json(res, list, 201);
      return;
    }

    const tplPatchMatch = pathname.match(/^\/api\/layout-templates\/([^/]+)$/);
    if (method === "PATCH" && tplPatchMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      const patch: { name?: string; layout?: LayoutDTO } = {};
      if (typeof body.name === "string") patch.name = body.name;
      if ("layout" in body) {
        if (!isLayoutShape(body.layout)) {
          error(res, "body.layout must be an object with an objects array and a canvas of numeric width and height");
          return;
        }
        patch.layout = body.layout;
      }
      if (patch.name === undefined && patch.layout === undefined) {
        error(res, "body.name (string) or body.layout (object) required");
        return;
      }
      const list = await updateLayoutTemplate(tplPatchMatch[1], patch);
      json(res, list);
      return;
    }

    const tplDeleteMatch = pathname.match(/^\/api\/layout-templates\/([^/]+)$/);
    if (method === "DELETE" && tplDeleteMatch) {
      const list = await deleteLayoutTemplate(tplDeleteMatch[1]);
      json(res, list);
      return;
    }

    // ── Layout groups (reusable object/container library) ─────────────────
    if (method === "GET" && pathname === "/api/layout-groups") {
      json(res, await listLayoutGroups());
      return;
    }

    if (method === "POST" && pathname === "/api/layout-groups") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.name !== "string" || body.object == null || typeof body.object !== "object") {
        error(res, "body.name (string) and body.object (object) required");
        return;
      }
      const list = await saveLayoutGroup(body.name, body.object as LayoutObject);
      json(res, list, 201);
      return;
    }

    const grpDeleteMatch = pathname.match(/^\/api\/layout-groups\/([^/]+)$/);
    if (method === "DELETE" && grpDeleteMatch) {
      const list = await deleteLayoutGroup(grpDeleteMatch[1]);
      json(res, list);
      return;
    }

    // ── Outputs (physical screens + routing) ──────────────────────────────
    if (method === "GET" && pathname === "/api/outputs") {
      json(res, stageController.getOutputs());
      return;
    }

    if (method === "POST" && pathname === "/api/outputs") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const viewId = typeof body.viewId === "string" ? body.viewId : null;
      const state = await stageController.addOutput(name, viewId);
      json(res, state, 201);
      return;
    }

    // POST /api/outputs/reorder — { ids: string[] }
    if (method === "POST" && pathname === "/api/outputs/reorder") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.ids)) {
        error(res, "body.ids (string[]) required");
        return;
      }
      const state = await stageController.reorderOutputs(body.ids as string[]);
      json(res, state);
      return;
    }

    // PATCH /api/outputs/:id — { name? }, { viewId? } (string|null = routing),
    // { blackout? } (boolean = full black screen), { locked? }, and/or { slug? }
    // (string; "" clears the friendly URL alias)
    const outputPatchMatch = pathname.match(/^\/api\/outputs\/([^/]+)$/);
    if (method === "PATCH" && outputPatchMatch) {
      const id = outputPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const hasName = typeof body.name === "string";
      const hasViewId = "viewId" in body
        && (typeof body.viewId === "string" || body.viewId === null);
      const hasBlackout = typeof body.blackout === "boolean";
      const hasLocked = typeof body.locked === "boolean";
      const hasSlug = typeof body.slug === "string";
      if (!hasName && !hasViewId && !hasBlackout && !hasLocked && !hasSlug) {
        error(res, "body.name (string), body.viewId (string|null), body.blackout (boolean), body.locked (boolean), or body.slug (string) required");
        return;
      }
      let state = stageController.getState();
      if (hasName) state = await stageController.renameOutput(id, body.name as string);
      if (hasViewId) state = await stageController.setOutputView(id, body.viewId as string | null);
      if (hasBlackout) state = await stageController.setOutputBlackout(id, body.blackout as boolean);
      if (hasLocked) state = await stageController.setOutputLocked(id, body.locked as boolean);
      // A rejected slug is a 400 with the reason, not a silent no-op — the operator
      // has to see WHY "/history" cannot be used.
      if (hasSlug) {
        try {
          state = await stageController.setOutputSlug(id, body.slug as string);
        } catch (err) {
          error(res, errorMessage(err));
          return;
        }
      }
      json(res, state);
      return;
    }

    // DELETE /api/outputs/:id
    const outputDeleteMatch = pathname.match(/^\/api\/outputs\/([^/]+)$/);
    if (method === "DELETE" && outputDeleteMatch) {
      const state = await stageController.removeOutput(outputDeleteMatch[1]);
      json(res, state);
      return;
    }

    if (method === "POST" && pathname === "/api/allowed-service-types") {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.ids)) {
        error(res, "body.ids (string[]) required");
        return;
      }
      const state = await stageController.setAllowedServiceTypes(body.ids as string[]);
      json(res, state);
      return;
    }

}
