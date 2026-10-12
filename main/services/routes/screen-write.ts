// What the routes that create a screen share: reading the body, and answering a
// failure.
//
// POST /api/outputs and POST /api/devices/claim both create through
// stageController.createScreen. The body is read in ONE place so the two cannot
// disagree about what a field means, and a refusal reads the same from either.

import type * as http from "node:http";

import { ScreenWriteError } from "../stage-controller.js";
import type { CreateScreenInput } from "../../types/views.js";
import { errorMessage } from "../errors.js";
import { error, json } from "./context.js";

/** The creation fields a body may carry. A claim that names an existing screen
 *  carries none of them. */
export const CREATE_SCREEN_FIELDS = ["viewId", "newView", "slug", "showInSidebar"] as const;

/**
 * Why a `mode` in a body is refused, or null when the body has none. A screen has
 * no role of its own: it is a control surface when the view it shows is a
 * console. Refused rather than ignored, because an ignored field is a script
 * believing it made a control surface and getting a wall display.
 */
export function modeRefusal(body: Record<string, unknown>): string | null {
  return "mode" in body
    ? 'body.mode is not accepted: a screen takes its role from the view it shows. Point it at a control-surface view, or create it with newView "control" ("wall" for a read-only one)'
    : null;
}

/**
 * Read a creation body. `name` and `viewId` are read as they always were, so a
 * body of only `{ name, viewId }` is the call it has always been (a value of the
 * wrong type is ignored, not refused). The fields added since are strict: one
 * that is present and the wrong type is a 400, not a field quietly dropped.
 *
 * Shape only. What a value MEANS — a view that does not exist, a slug that is
 * taken — is createScreen's to refuse.
 */
export function readCreateScreenBody(body: Record<string, unknown>): CreateScreenInput | { error: string } {
  const refused = modeRefusal(body);
  if (refused) return { error: refused };
  const input: CreateScreenInput = {
    name: typeof body.name === "string" ? body.name : undefined,
    viewId: typeof body.viewId === "string" ? body.viewId : null,
  };
  if ("newView" in body) {
    if (body.newView !== "wall" && body.newView !== "control") return { error: 'body.newView must be "wall" or "control"' };
    input.newView = body.newView;
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
 * anything else a screen write throws is a refusal made before anything was
 * written, a 400 with the reason.
 */
export function answerScreenWriteFailure(res: http.ServerResponse, err: unknown): void {
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
