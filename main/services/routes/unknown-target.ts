// unknown-target.ts — the 404 for an edit, remove or test of a LAN target that is not in its list.

import type * as http from "node:http";

import { errorMessage } from "../errors.js";
import { UnknownTargetError } from "../target-list.js";
import { error } from "./context.js";

/**
 * Run a route's work on a target list and answer an unknown id as 404. Not in
 * handlerErrorStatus: that answers for every route, and a 404 declared by some
 * unrelated error would start reading as "not found" instead of a fault.
 * Anything else is rethrown for the server's own error path.
 */
export async function answeringUnknownTarget(res: http.ServerResponse, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof UnknownTargetError)) throw err;
    error(res, errorMessage(err), 404);
  }
}
