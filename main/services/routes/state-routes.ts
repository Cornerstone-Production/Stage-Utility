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
