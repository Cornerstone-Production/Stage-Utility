// state-routes.ts — Health + stage state
//
// The health probe and the full StageState snapshot.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error } from "./context.js";
import { errorMessage } from "../errors.js";
import { stageController } from "../stage-controller.js";
import { SERVER_VERSION } from "../server-version.js";
import { UPCOMING_DEFAULT_DAYS, UPCOMING_MAX_DAYS } from "../upcoming-plans.js";

export async function stateRoutes(c: RouteCtx): Promise<void> {
  const { res, pathname, url, method } = c;
    // ── Health ────────────────────────────────────────────────────────────
    // Identity payload: lets an external client (e.g. the Bitfocus Companion
    // module) confirm it reached a Stage Utility server and show its version/name.
    if (method === "GET" && pathname === "/api/health") {
      json(res, {
        ok: true,
        app: "stage-utility",
        version: SERVER_VERSION,
        name: stageController.getState().appName,
      });
      return;
    }

    // ── Stage state ───────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/state") {
      json(res, stageController.getState());
      return;
    }

    if (method === "GET" && pathname === "/api/service-types") {
      try {
        json(res, await stageController.listServiceTypes());
      } catch (err) {
      // 502, not 500: the request was well-formed, so reaching Planning Center
      // is the only way this fails, and a 500 tells the operator this app broke
      // when the upstream is down. The calendar routes make the same argument
      // the other way round: a 400 would blame the caller. Without a try this
      // reached the dispatcher's generic arm, which is 500 by design because a
      // status is opt-in.
        error(res, errorMessage(err), 502);
      }
      return;
    }

    if (method === "GET" && pathname === "/api/team-positions") {
      try {
        json(res, await stageController.listTeamPositions());
      } catch (err) {
        error(res, errorMessage(err), 502);
      }
      return;
    }

    // Every allowed service type's plans in one dated list, for the editor's plan
    // switcher. Deliberately 200 even when Planning Center is unreachable: the
    // body carries `unavailable` and the editor stays usable on the plan the
    // machine is already on, where a 502 would read as "this app is broken".
    if (method === "GET" && pathname === "/api/plans/upcoming") {
      // FLOOR FIRST, then test the range. `?days=0.5` passed `> 0` and floored to
      // zero afterwards, so the window was one day and the switcher could offer
      // nothing past tonight — a nonsense value that read as a working list.
      // Anything under a whole day now falls back to the default rather than
      // being rounded up, the same answer `?days=banana` gets.
      const raw = Math.floor(Number(url.searchParams.get("days")));
      const days =
        Number.isFinite(raw) && raw > 0 ? Math.min(raw, UPCOMING_MAX_DAYS) : UPCOMING_DEFAULT_DAYS;
      const dto = await stageController.getUpcomingPlanList(days);
      // Also a header, so a proxy or a curl can see the age without parsing.
      res.setHeader("X-Plans-Cache-Age-Ms", String(dto.cacheAgeMs));
      json(res, dto);
      return;
    }

    if (method === "GET" && pathname === "/api/plans") {
      const serviceTypeId = url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      try {
        json(res, await stageController.listPlans(serviceTypeId));
      } catch (err) {
        error(res, errorMessage(err), 502);
      }
      return;
    }

}
