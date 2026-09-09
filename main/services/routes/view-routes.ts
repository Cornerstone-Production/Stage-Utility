// view-routes.ts — Displays, views, layouts, outputs
//
// The content model: displays (legacy), Views, reusable layout templates and
// groups, and the Outputs that route a View to a screen.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { buildViewBundle } from "../view-export.js";
import { applyViewBundle } from "../view-import.js";
import {
  listLayoutTemplates,
  saveLayoutTemplate,
  updateLayoutTemplate,
  deleteLayoutTemplate,
  listLayoutGroups,
  saveLayoutGroup,
  deleteLayoutGroup,
} from "../layout-library.js";
import type { NotesContent } from "../notes-store.js";
import { errorMessage } from "../errors.js";
import { type RouteCtx, json, error, readBody, isDisplayKind, MAX_CONFIG_BODY_BYTES } from "./context.js";
import { isLayoutShape } from "../../types/views.js";
import { oscManager } from "../osc-manager.js";
import { rosstalkManager } from "../rosstalk-manager.js";
import type { ViewKind, LayoutDTO, LayoutObject, Slot, SlotsLayout, SlotsScope } from "../../types/stage.js";
import { readSlotsTarget, INVALID_TARGET, TARGET_ERROR } from "../slots-target-body.js";
import { LayoutConflictError, SlotsNotFoundError, stageController } from "../stage-controller.js";
import type { CalendarSelection } from "../../types/calendar.js";
import { calendarBroadcaster } from "../calendar-broadcaster.js";
import { zonedDateKey } from "../app-timezone.js";

/**
 * An untrusted body value that is a list of `{ id, name }` strings.
 *
 * A type PREDICATE, so the narrowing it performs is the thing handed on. The
 * first draft returned a bare boolean and needed a second function to rebuild
 * the list past a cast — two passes over the same value where one does, and the
 * cast was the part that asserted rather than proved.
 */
function isSelectionList(v: unknown): v is CalendarSelection[] {
  return (
    Array.isArray(v) &&
    v.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { id?: unknown }).id === "string" &&
        typeof (e as { name?: unknown }).name === "string",
    )
  );
}

/**
 * `stage-utility-view-left-mic-display-2026-08-17.json`.
 *
 * The name is operator-supplied text going into a quoted header value, so the
 * slug keeps only [a-z0-9-] — a quote or a path separator surviving here would
 * be a header injection, not a cosmetic problem. Bounded because some
 * filesystems cap a path component at 255 bytes.
 */
export function exportFilename(name: string, now: Date): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  // The app's zone, not the server's clock: a UTC box dates a file exported at
  // 22:30 in Chicago as the next day. patch-export.ts fixed the same line first;
  // this and the config and archive exports are the other three copies.
  return `stage-utility-view-${slug ? `${slug}-` : ""}${zonedDateKey(now.getTime())}.json`;
}

/**
 * Answer a slots failure the controller RAISED DELIBERATELY, and rethrow
 * anything else.
 *
 * Every slots route here used to wrap its whole call in `catch → 404`, so a
 * store write that failed for any other reason — a full disk, a TypeError from
 * an unsafe key — reached the operator as "there was nothing to revert" and left
 * no 500 in the log to find later. `SlotsNotFoundError` carries the status it
 * deserves (404 for a thing that is not there, 400 for a target that cannot be
 * true); everything else goes up to the dispatcher, which answers 500 and logs.
 */
function slotsFailure(res: RouteCtx["res"], err: unknown): void {
  if (!(err instanceof SlotsNotFoundError)) throw err;
  error(res, err.message, err.status);
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

    // POST /api/notes — { objectId, content }
    // What an operator typed into a notes/checklist object. Awaited before the
    // response, so a failed write is a failed request rather than a silent loss.
    if (method === "POST" && pathname === "/api/notes") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.objectId !== "string" || typeof body.content !== "object" || body.content === null) {
        error(res, "body.objectId (string) and body.content (object) required");
        return;
      }
      try {
        json(res, await stageController.setNotes(body.objectId, body.content as NotesContent));
      } catch (err) {
        error(res, errorMessage(err));
      }
      return;
    }

    if (method === "POST" && pathname === "/api/views") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : undefined;
      const kind = isDisplayKind(body.kind) ? body.kind : "slots";
      const surface = body.surface === "console" ? "console" : "display";
      const state = await stageController.createView(name ?? "", kind, surface);
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

    // GET /api/views/:id/slot-targets and /api/layout-objects/:id/slot-targets —
    // the type's default board and the current plan's override, in one read. Must
    // precede the /slots matchers only in the sense that these paths differ; kept
    // together with them because they are the same pair of surfaces.
    const targetsMatch = pathname.match(/^\/api\/(views|layout-objects)\/([^/]+)\/slot-targets$/);
    if (method === "GET" && targetsMatch) {
      const scope: SlotsScope = targetsMatch[1] === "views" ? "view" : "object";
      try {
        json(res, await stageController.getSlotTargets(scope, decodeURIComponent(targetsMatch[2])));
      } catch (err) {
        slotsFailure(res, err);
      }
      return;
    }

    // DELETE /api/views/:id/slots/override/:planId (and the layout-object form) —
    // "Revert to default". 404 when there was no override, so the client can tell
    // a revert that happened from one that had nothing to do.
    const overrideMatch = pathname.match(
      /^\/api\/(views|layout-objects)\/([^/]+)\/slots\/override\/([^/]+)$/,
    );
    if (method === "DELETE" && overrideMatch) {
      const scope: SlotsScope = overrideMatch[1] === "views" ? "view" : "object";
      try {
        json(res, await stageController.clearSlotsOverride(
          scope,
          decodeURIComponent(overrideMatch[2]),
          decodeURIComponent(overrideMatch[3]),
        ));
      } catch (err) {
        slotsFailure(res, err);
      }
      return;
    }

    // POST /api/views/:id/slots/promote — { planId } — "Set as default": copy the
    // plan's board onto the service type's default and drop the override.
    const promoteMatch = pathname.match(/^\/api\/(views|layout-objects)\/([^/]+)\/slots\/promote$/);
    if (method === "POST" && promoteMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.planId !== "string") {
        error(res, "body.planId (string) required");
        return;
      }
      const scope: SlotsScope = promoteMatch[1] === "views" ? "view" : "object";
      try {
        json(res, await stageController.promoteSlotsOverride(
          scope,
          decodeURIComponent(promoteMatch[2]),
          body.planId,
        ));
      } catch (err) {
        slotsFailure(res, err);
      }
      return;
    }

    // POST /api/views/:id/slots — { slots, target? }
    const viewSlotsMatch = pathname.match(/^\/api\/views\/([^/]+)\/slots$/);
    if (method === "POST" && viewSlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const target = readSlotsTarget(body.target);
      if (target === INVALID_TARGET) {
        error(res, TARGET_ERROR);
        return;
      }
      try {
        json(res, await stageController.setViewSlots(viewSlotsMatch[1], body.slots as Slot[], target));
      } catch (err) {
        slotsFailure(res, err);
      }
      return;
    }

    // POST /api/layout-objects/:objectId/slots — { slots, target? } (inline grid)
    const objectSlotsMatch = pathname.match(/^\/api\/layout-objects\/([^/]+)\/slots$/);
    if (method === "POST" && objectSlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (!Array.isArray(body.slots)) {
        error(res, "body.slots (array) required");
        return;
      }
      const target = readSlotsTarget(body.target);
      if (target === INVALID_TARGET) {
        error(res, TARGET_ERROR);
        return;
      }
      try {
        json(res, await stageController.setLayoutObjectSlots(objectSlotsMatch[1], body.slots as Slot[], target));
      } catch (err) {
        slotsFailure(res, err);
      }
      return;
    }

    // POST /api/views/import — merge a bundle in and report what happened.
    if (method === "POST" && pathname === "/api/views/import") {
      try {
        // A bundle carries base64 images, so the ordinary JSON ceiling would
        // refuse a file this app exported — the same reason /api/config/import
        // uses this limit.
        const report = await applyViewBundle(await readBody(req, MAX_CONFIG_BODY_BYTES));

        // Telling the managers is the ROUTE's job, not the merge service's.
        // Both hold their targets in memory and write that array back on the
        // next edit, so a store written without telling them leaves the imported
        // target not live AND erased the first time any target is touched.
        //
        // It lives here because reloadTargets opens sockets, and a service whose
        // job is "merge this data" must not: doing it inside applyViewBundle
        // left three UDP handles open in every unit test that imported a target,
        // which hung the whole suite on CI while passing locally, where
        // something already held the port.
        //
        // A reload that fails does not fail the import — the data is already
        // correct on disk — but it is reported rather than logged.
        for (const [kind, reload] of [
          ["osc", () => oscManager.reloadTargets()],
          ["rosstalk", () => rosstalkManager.reloadTargets()],
        ] as const) {
          if (!report.targetsAdded.some((t) => t.kind === kind)) continue;
          try {
            await reload();
          } catch (reloadErr) {
            report.skipped.push(
              `${kind.toUpperCase()} targets were saved but are not live until a restart: ` +
              `${errorMessage(reloadErr)}`,
            );
          }
        }

        // BEFORE the reply, not in a finally after it. The importer writes to
        // several stores directly, so the controller's in-memory views are stale
        // either way — and a stale list is not merely wrong on screen, it is what
        // the next rename or delete writes back, erasing whatever did land.
        //
        // It used to be `finally { await reloadViews() }`, which ran after the
        // response was already written. A rejection there escaped to the catch
        // below, which called error() → json() → writeHead() on a finished
        // response: ERR_HTTP_HEADERS_SENT thrown from inside an async catch, an
        // unhandled rejection, and the process gone. Doing it here means a
        // failure is something the operator READS, in the same shape
        // reloadTargets uses twelve lines above.
        await stageController.reloadViews().catch((reloadErr: unknown) => {
          report.skipped.push(
            `Everything was imported, but the running server did not pick the views up: ` +
            `${errorMessage(reloadErr)} — restart it before editing them.`,
          );
        });
        json(res, report);
      } catch (err) {
        // Still always, even on the failure path, and still unable to take the
        // process down: the reply has not been sent yet here.
        await stageController.reloadViews().catch(() => {});
        error(res, errorMessage(err));
      }
      return;
    }

    // GET /api/views/:id/export — the whole view as one file.
    const viewExportMatch = pathname.match(/^\/api\/views\/([^/]+)\/export$/);
    if (method === "GET" && viewExportMatch) {
      try {
        const bundle = await buildViewBundle(decodeURIComponent(viewExportMatch[1]));
        const filename = exportFilename(bundle.views[0].name, new Date());
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(bundle, null, 2));
      } catch (err) {
        // 404 only for an unknown view. A read error is not "not found", and
        // answering 404 for it sends somebody looking for a missing view.
        const msg = errorMessage(err);
        error(res, msg, /unknown view/.test(msg) ? 404 : 500);
      }
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

    // POST /api/views/:id/copy-slots — { fromViewId, target? }
    //
    // `target` is the SAME optional field a slot save takes, read through the
    // same validator, and it names one board on both sides of the copy. Without
    // it this wrote the source's default over the destination's default whichever
    // side the editor was on, and deleted the destination's board for the current
    // plan on the way past.
    const viewCopySlotsMatch = pathname.match(/^\/api\/views\/([^/]+)\/copy-slots$/);
    if (method === "POST" && viewCopySlotsMatch) {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.fromViewId !== "string") {
        error(res, "body.fromViewId (string) required");
        return;
      }
      const target = readSlotsTarget(body.target);
      if (target === INVALID_TARGET) {
        error(res, TARGET_ERROR);
        return;
      }
      try {
        json(res, await stageController.copyViewSlots(viewCopySlotsMatch[1], body.fromViewId, target));
      } catch (err) {
        slotsFailure(res, err);
      }
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
      const hasScriptViewLayout = "scriptViewLayoutId" in body
        && (body.scriptViewLayoutId === null || typeof body.scriptViewLayoutId === "string");
      const hasHideChrome = typeof body.hideChrome === "boolean";
      // Both calendar lists move together — a picker change sends the pair, so a
      // request carrying one and not the other is a client that has lost half its
      // state, not a partial update to honour.
      const calendarFilters =
        isSelectionList(body.calendarSources) && isSelectionList(body.calendarTags)
          ? { sources: body.calendarSources, tags: body.calendarTags }
          : null;
      if (("calendarSources" in body || "calendarTags" in body) && !calendarFilters) {
        error(res, "body.calendarSources and body.calendarTags must BOTH be arrays of { id, name } strings");
        return;
      }
      // Narrowed to a literal rather than cast: `as` asserts a type without
      // proving it, so the value handed on is still the caller's string as far
      // as anything reading the code — or analysing it — can tell.
      const surface = body.surface === "console" ? "console" : body.surface === "display" ? "display" : null;
      const hasSurface = surface !== null;
      if (!hasName && !hasKind && !hasNdiSource && !hasLayout && !hasSlotsLayout && !hasScriptViewLayout && !hasSurface && !hasHideChrome && !calendarFilters) {
        error(res, "body.name (string), body.kind, body.ndiSource (string|null), body.layout (object), body.slotsLayout (object|null), body.surface (\"display\"|\"console\"), body.scriptViewLayoutId (string|null), body.hideChrome (boolean), or body.calendarSources + body.calendarTags (arrays) required");
        return;
      }
      let state = stageController.getState();
      if (hasName) state = await stageController.renameView(id, body.name as string);
      // Refused with its reason: converting a bound View names the screens it
      // would strand rather than silently unbinding them.
      if (hasSurface) {
        try {
          state = await stageController.setViewSurface(id, surface);
        } catch (err) {
          error(res, errorMessage(err));
          return;
        }
      }
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
      if (hasScriptViewLayout) state = await stageController.setViewScriptViewLayout(id, body.scriptViewLayoutId as string | null);
      if (hasHideChrome) state = await stageController.setViewHideChrome(id, body.hideChrome as boolean);
      if (calendarFilters) {
        state = await stageController.setViewCalendarFilters(id, calendarFilters.sources, calendarFilters.tags);
        // Forced past the subscriber gate and NOT awaited. The operator who just
        // changed a filter is looking at the screen, so the grid must reapply now
        // rather than up to three minutes later — but a PCO read must not hold
        // the settings save open, and the save has already succeeded either way.
        calendarBroadcaster.refreshInBackground("filter change", true);
      }
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
      const { state } = await stageController.addOutput(name, viewId);
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
    // { blackout? } (boolean = full black screen), { locked? }, { hideTopBar? }
    // (boolean = draw no kiosk top bar), and/or { slug? } (string; "" clears the
    // friendly URL alias)
    const outputPatchMatch = pathname.match(/^\/api\/outputs\/([^/]+)$/);
    if (method === "PATCH" && outputPatchMatch) {
      const id = outputPatchMatch[1];
      const body = await readBody(req) as Record<string, unknown>;
      const hasName = typeof body.name === "string";
      const hasViewId = "viewId" in body
        && (typeof body.viewId === "string" || body.viewId === null);
      const hasBlackout = typeof body.blackout === "boolean";
      const hasLocked = typeof body.locked === "boolean";
      const hasHideTopBar = typeof body.hideTopBar === "boolean";
      const hasSlug = typeof body.slug === "string";
      const mode = body.mode === "panel" ? "panel" : body.mode === "display" ? "display" : null;
      const hasMode = mode !== null;
      if (!hasName && !hasViewId && !hasBlackout && !hasLocked && !hasHideTopBar && !hasSlug && !hasMode) {
        error(res, "body.name (string), body.viewId (string|null), body.blackout (boolean), body.locked (boolean), body.hideTopBar (boolean), body.mode (\"display\"|\"panel\"), or body.slug (string) required");
        return;
      }
      let state = stageController.getState();
      if (hasName) state = await stageController.renameOutput(id, body.name as string);
      // Mode BEFORE viewId, so a single request can turn a screen into a panel
      // and point it at a console. The other order refuses its own second half.
      if (hasMode) {
        try {
          state = await stageController.setOutputMode(id, mode);
        } catch (err) {
          error(res, errorMessage(err));
          return;
        }
      }
      // A refused binding is a 400 with the reason, not a 500 stack trace: the
      // operator has to see WHY a console will not go on a wall screen.
      if (hasViewId) {
        try {
          state = await stageController.setOutputView(id, body.viewId as string | null);
        } catch (err) {
          error(res, errorMessage(err));
          return;
        }
      }
      if (hasBlackout) state = await stageController.setOutputBlackout(id, body.blackout as boolean);
      if (hasLocked) state = await stageController.setOutputLocked(id, body.locked as boolean);
      if (hasHideTopBar) state = await stageController.setOutputHideTopBar(id, body.hideTopBar as boolean);
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
