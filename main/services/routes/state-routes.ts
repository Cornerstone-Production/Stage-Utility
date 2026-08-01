// state-routes.ts — Health + stage state
//
// The health probe and the full StageState snapshot.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error } from "./context.js";
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
      const types = await stageController.listServiceTypes();
      json(res, types);
      return;
    }

    if (method === "GET" && pathname === "/api/team-positions") {
      const positions = await stageController.listTeamPositions();
      json(res, positions);
      return;
    }

    if (method === "GET" && pathname === "/api/plans") {
      const serviceTypeId = url.searchParams.get("serviceTypeId");
      if (!serviceTypeId) {
        error(res, "serviceTypeId query param required");
        return;
      }
      const plans = await stageController.listPlans(serviceTypeId);
      json(res, plans);
      return;
    }

}
