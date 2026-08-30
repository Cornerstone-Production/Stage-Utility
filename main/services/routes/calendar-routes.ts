// calendar-routes.ts — the Planning Center Calendar month grid.
//
// One route. The grid is built HERE rather than in the browser because the days
// have to be bucketed in the app time zone, which is a server setting the
// renderer cannot see — see main/services/calendar-grid.ts for why that is not
// a detail.
//
// Every route must finish responding before it returns (see RouteCtx).

import { errorMessage } from "../errors.js";
import { monthOffsetOf } from "../calendar-grid.js";
import { stageController } from "../stage-controller.js";
import { type RouteCtx, json, error } from "./context.js";

export async function calendarRoutes(c: RouteCtx): Promise<void> {
  const { res, pathname, url, method } = c;

  if (method === "GET" && pathname === "/api/pco/calendar") {
    // `month` is optional and, when present, must be a real YYYY-MM within the
    // paging bound. Rejected rather than coerced: falling back to the current
    // month would draw the operator a different month than the one they asked
    // for, with nothing on screen to say so.
    const month = url.searchParams.get("month");
    let offset = 0;
    if (month !== null) {
      try {
        offset = monthOffsetOf(month);
      } catch (err) {
        error(res, errorMessage(err));
        return;
      }
    }
    try {
      json(res, await stageController.getCalendarGrid(url.searchParams.get("viewId"), offset));
    } catch (err) {
      // 502, not 400: the request was well-formed — `month` was validated above —
      // so reaching Planning Center is the only way this gets here, and a 400
      // would blame the caller for the upstream being down. Rethrowing instead
      // would leave the response unsent, which the dispatcher reads as unhandled
      // — see the ONE RULE in context.ts.
      json(res, { error: errorMessage(err) }, 502);
    }
    return;
  }

  // The org's calendars and tags, for the two pickers in a calendar View's
  // settings. Read live so a renamed tag appears under its new name.
  if (method === "GET" && pathname === "/api/pco/calendar-sources") {
    try {
      json(res, await stageController.listCalendarSources());
    } catch (err) {
      json(res, { error: errorMessage(err) }, 502);
    }
    return;
  }
}
