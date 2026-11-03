// home-routes.ts -- the snoozes behind Home's Needs attention.
//
// Every route must finish responding before it returns (see RouteCtx).
//
//   GET    /api/home/snoozes        the home:snoozes snapshot { rev, snoozes }
//   POST   /api/home/snoozes        { key, severity } -> 201 with the snooze
//   DELETE /api/home/snoozes/:key   { ok: true }; 404 when that key is not snoozed
//
// A key or severity that breaks a rule is a 400 that says which. A write that
// failed is left to the server's own handler, which answers 500: a snooze that
// did not save must not read as one that did.

import { homeSnoozes, SnoozeRefused } from "../home-snoozes.js";
import { stageController } from "../stage-controller.js";
import { type RouteCtx, error, json, readBodyOrEmpty } from "./context.js";

export async function homeRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

  if (method === "GET" && pathname === "/api/home/snoozes") {
    json(res, homeSnoozes.state());
    return;
  }

  if (method === "POST" && pathname === "/api/home/snoozes") {
    const body = await readBodyOrEmpty(req);
    try {
      json(res, await homeSnoozes.snooze(body.key, body.severity, stageController.getState().pcoConfigured), 201);
    } catch (err) {
      if (!(err instanceof SnoozeRefused)) throw err;
      error(res, err.message);
    }
    return;
  }

  const one = pathname.match(/^\/api\/home\/snoozes\/([^/]+)$/);
  if (method === "DELETE" && one) {
    let key: string;
    try {
      key = decodeURIComponent(one[1]);
    } catch {
      error(res, "that key is not valid");
      return;
    }
    if (await homeSnoozes.unsnooze(key)) {
      json(res, { ok: true });
    } else {
      error(res, "that is not snoozed", 404);
    }
    return;
  }
}
