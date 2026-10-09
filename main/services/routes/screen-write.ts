// What the routes that create a screen, or change its role, share: reading the
// body, and answering a failure.
//
// POST /api/outputs and POST /api/devices/claim both create through
// stageController.createScreen. The body is read in ONE place so the two cannot
// disagree about what a field means, and a refusal reads the same from either.

import type * as http from "node:http";

import { ScreenWriteError, type CreateScreenInput } from "../stage-controller.js";
import { errorMessage } from "../errors.js";
import { error, json } from "./context.js";

/** The creation fields a body may carry. A claim that names an existing screen
 *  carries none of them. */
export const CREATE_SCREEN_FIELDS = ["mode", "viewId", "newView", "slug", "showInSidebar"] as const;

/**
 * Read a creation body. `name` and `viewId` are read as they always were, so a
 * body of only `{ name, viewId }` is the call it has always been (a value of the
 * wrong type is ignored, not refused). The fields added since are strict: one
 * that is present and the wrong type is a 400, not a field quietly dropped.
 */
export function readCreateScreenBody(body: Record<string, unknown>): CreateScreenInput | { error: string } {
  const input: CreateScreenInput = {
    name: typeof body.name === "string" ? body.name : undefined,
    viewId: typeof body.viewId === "string" ? body.viewId : null,
  };
  if ("mode" in body) {
    if (body.mode !== "display" && body.mode !== "panel") return { error: 'body.mode must be "display" or "panel"' };
    input.mode = body.mode;
  }
  if ("newView" in body) {
    if (typeof body.newView !== "boolean") return { error: "body.newView must be a boolean" };
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
