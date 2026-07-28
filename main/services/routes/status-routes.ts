// status-routes.ts — Live status reads + SPL history
//
// Read-only status snapshots that let a freshly-loaded display hydrate
// without waiting for the next broadcast, plus the SPL history store.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, readBody } from "./context.js";
import { stageController } from "../stage-controller.js";
import { integrationManager } from "../integration-manager.js";
import { obsService } from "../obs-service.js";
import { reaperService } from "../reaper-service.js";
import { oscManager } from "../osc-manager.js";
import { sensourceService } from "../sensource-service.js";
import { smaartService } from "../smaart-service.js";
import { splHistoryStore } from "../spl-history-store.js";
import { splRecorder } from "../spl-recorder.js";
import { propresenterService, propresenterManager } from "../propresenter-service.js";

export async function statusRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
    // Hydrate-on-connect endpoints (the live channels only broadcast on change).
    if (method === "GET" && pathname === "/api/propresenter/status") {
      json(res, propresenterService.getStatus());
      return;
    }
    if (method === "GET" && pathname === "/api/propresenter/instances") {
      json(res, propresenterManager.getInstancesDto());
      return;
    }
    if (method === "GET" && pathname === "/api/pco/live") {
      json(res, await stageController.fetchLive());
      return;
    }
    if (method === "GET" && pathname === "/api/spl/metrics") {
      json(res, smaartService.getLatest());
      return;
    }
    if (method === "GET" && pathname === "/api/obs/status") {
      json(res, obsService.getLatest());
      return;
    }
    if (method === "GET" && pathname === "/api/reaper/status") {
      json(res, reaperService.getLatest());
      return;
    }
    if (method === "GET" && pathname === "/api/osc/feedback") {
      json(res, oscManager.getFeedback());
      return;
    }
    if (method === "GET" && pathname === "/api/people/count") {
      json(res, sensourceService.getLatest());
      return;
    }
    if (method === "GET" && pathname === "/api/sensource/locations") {
      try {
        json(res, await integrationManager.getSensourceLocations());
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 502);
      }
      return;
    }
    if (method === "GET" && pathname === "/api/sensource/zones") {
      try {
        json(res, await integrationManager.getSensourceZones());
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 502);
      }
      return;
    }
    if (method === "GET" && pathname === "/api/spl/history/current") {
      json(res, splRecorder.getCurrent());
      return;
    }
    if (method === "GET" && pathname === "/api/spl/history") {
      json(res, await splHistoryStore.list());
      return;
    }
    if (method === "GET" && pathname === "/api/spl/visible-metrics") {
      json(res, { metrics: await splHistoryStore.getVisibleMetrics() });
      return;
    }
    if (method === "POST" && pathname === "/api/spl/visible-metrics") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const metrics = Array.isArray(body.metrics) ? (body.metrics as unknown[]) : [];
      json(res, { metrics: await splHistoryStore.setVisibleMetrics(metrics as string[]) });
      return;
    }
    {
      const histMatch = pathname.match(/^\/api\/spl\/history\/([^/]+)$/);
      if (histMatch && histMatch[1] !== "current") {
        const key = decodeURIComponent(histMatch[1]);
        if (method === "GET") {
          json(res, await splHistoryStore.get(key));
          return;
        }
        if (method === "DELETE") {
          json(res, { deleted: await splHistoryStore.delete(key) });
          return;
        }
      }
    }

}
