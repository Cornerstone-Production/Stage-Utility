// What the routes that create a screen share: reading the body, and answering a
// failure.
//
// POST /api/outputs and POST /api/devices/claim both create through
// stageController.createScreen. The body is read in ONE place so the two cannot
// disagree about what a field means, and a refusal reads the same from either.

import type * as http from "node:http";

import { ScreenWriteError, ViewSurfaceChangedError } from "../stage-controller.js";
import { isLayoutShape, type CreateScreenInput } from "../../types/views.js";
import { StoreReadError } from "../data-store.js";
import { errorMessage } from "../errors.js";
import { error, isDisplayKind, json } from "./context.js";

/** The creation fields a body may carry. A claim that names an existing screen
 *  carries none of them. */
export const CREATE_SCREEN_FIELDS = ["viewId", "newView", "viewKind", "layout", "slug", "showInSidebar", "expectSurface"] as const;

/**
 * Answer a body that carries a `mode` with a 400, and say whether it did. A
 * screen has no role of its own: it is a control surface when the view it shows
 * is a console. Refused rather than ignored, because an ignored field is a script
 * believing it made a control surface and getting a wall display.
 */
export function refuseMode(res: http.ServerResponse, body: Record<string, unknown>): boolean {
  if (!("mode" in body)) return false;
  error(
    res,
    'body.mode is not accepted: a screen takes its role from the view it shows. Point it at a control-surface view, or create it with newView "control" ("wall" for a read-only one)',
  );
  return true;
}

/**
 * Read a creation body. `name` and `viewId` are read as they always were, so a
 * body of only `{ name, viewId }` is the call it has always been (a value of the
 * wrong type is ignored, not refused). The fields added since are strict: one
 * that is present and the wrong type is a 400, not a field quietly dropped.
 *
 * A `mode` is NOT checked here: each route refuses it once, itself (refuseMode),
 * because a claim naming an existing screen has no creation body to read.
 *
 * Shape only. What a value MEANS — a view that does not exist, a slug that is
 * taken — is createScreen's to refuse.
 */
export function readCreateScreenBody(body: Record<string, unknown>): CreateScreenInput | { error: string } {
  const input: CreateScreenInput = {
    name: typeof body.name === "string" ? body.name : undefined,
    viewId: typeof body.viewId === "string" ? body.viewId : null,
  };
  if ("newView" in body) {
    if (body.newView !== "wall" && body.newView !== "control") return { error: 'body.newView must be "wall" or "control"' };
    input.newView = body.newView;
  }
  if ("viewKind" in body) {
    if (!isDisplayKind(body.viewKind)) return { error: "body.viewKind must be a view kind" };
    input.viewKind = body.viewKind;
  }
  if ("layout" in body) {
    if (!isLayoutShape(body.layout)) return { error: "body.layout must be an object with an objects array and a canvas of numeric width and height" };
    input.layout = body.layout;
  }
  if ("expectSurface" in body) {
    if (body.expectSurface !== "display" && body.expectSurface !== "console") return { error: 'body.expectSurface must be "display" or "console"' };
    // Checked against the view in `viewId`, so it means nothing without one, or with
    // a view being made: an ignored field is a caller believing the check ran.
    if (typeof body.viewId !== "string" || "newView" in body) {
      return { error: "body.expectSurface is checked against body.viewId, which must name an existing view (and not come with newView)" };
    }
    input.expectSurface = body.expectSurface;
  }
  if ("slug" in body) {
    if (typeof body.slug !== "string") return { error: "body.slug must be a string" };
    input.slug = body.slug;
  }
  if ("showInSidebar" in body) {
    if (typeof body.showInSidebar !== "boolean") return { error: "body.showInSidebar must be a boolean" };
    input.showInSidebar = body.showInSidebar;
  }
  return input;
}

/**
 * Answer a failed screen write. A ScreenWriteError is the server failing part-way
 * through, so it is a 500 that says which step and what was and was not put back;
 * a view that is not the kind the caller expected is a 409; anything else a screen
 * write throws is a refusal made before anything was written, a 400 with the reason.
 * A StoreReadError is rethrown, to be answered 503.
 */
export function answerScreenWriteFailure(res: http.ServerResponse, err: unknown): void {
  // A store the server cannot read is not the caller's mistake: it travels up to
  // the dispatcher, which answers it 503 like every other route does.
  if (err instanceof StoreReadError) throw err;
  // The view changed kind while the operator was deciding: nothing was made, and
  // `surface` is what the view is now to ask again with (as PATCH answers).
  if (err instanceof ViewSurfaceChangedError) {
    json(res, { error: err.message, code: err.code, surface: err.surface }, 409);
    return;
  }
  if (err instanceof ScreenWriteError) {
    json(
      res,
      { error: err.message, failed: err.failed, rolledBack: err.rolledBack, notRolledBack: err.notRolledBack },
      500,
    );
    return;
  }
  error(res, errorMessage(err));
}
