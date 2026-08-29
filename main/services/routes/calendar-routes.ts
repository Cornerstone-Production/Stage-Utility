// calendar-routes.ts — the Planning Center Calendar month grid.
//
// One route. The grid is built HERE rather than in the browser because the days
// have to be bucketed in the app time zone, which is a server setting the
// renderer cannot see — see main/services/calendar-grid.ts for why that is not
// a detail.
//
// Every route must finish responding before it returns (see RouteCtx).

import { errorMessage } from "../errors.js";
import { stageController } from "../stage-controller.js";
import { type RouteCtx, json } from "./context.js";

export async function calendarRoutes(c: RouteCtx): Promise<void> {
  const { res, pathname, url, method } = c;

  if (method === "GET" && pathname === "/api/pco/calendar") {
    try {
      json(res, await stageController.getCalendarGrid(url.searchParams.get("viewId")));
    } catch (err) {
      // 502, not 400: reaching Planning Center is the only way this fails, and a
      // 400 would tell the operator they sent a bad request when the upstream is
      // down. Rethrowing instead would leave the response unsent, which the
      // dispatcher reads as unhandled — see the ONE RULE in context.ts.
      json(res, { error: errorMessage(err) }, 502);
    }
    return;
  }
}
