// status-routes.ts — Live status reads + SPL history
//
// Read-only status snapshots that let a freshly-loaded display hydrate
// without waiting for the next broadcast, plus the SPL history store.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { errorMessage } from "../errors.js";
import { type RouteCtx, error, json, readBody } from "./context.js";
import { stageController } from "../stage-controller.js";
import { integrationManager } from "../integration-manager.js";
import { obsService } from "../obs-service.js";
import { resiService } from "../resi-service.js";
import { youtubeService } from "../youtube-service.js";
import { pvpService } from "../pvp-service.js";
import { reaperService } from "../reaper-service.js";
import { scoresService } from "../scores-service.js";
import { scoresStore } from "../scores-store.js";
import { leagueById, type ScoreFavourite } from "../../types/scores.js";
import { oscManager } from "../osc-manager.js";
import { sensourceService } from "../sensource-service.js";
import { smaartService } from "../smaart-service.js";
import { splHistoryStore } from "../spl-history-store.js";
import { splRecorder } from "../spl-recorder.js";
import { deleteServiceRecords } from "../history-edit.js";
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
    if (method === "GET" && pathname === "/api/pvp/status") {
      json(res, pvpService.getLatest());
      return;
    }

    // ── Live scores ────────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/scores/status") {
      json(res, scoresService.getLatest());
      return;
    }
    if (method === "GET" && pathname === "/api/scores/favourites") {
      await scoresStore.init();
      json(res, scoresStore.get());
      return;
    }
    if (method === "POST" && pathname === "/api/scores/favourites") {
      const body = (await readBody(req)) as Record<string, unknown>;
      if (!Array.isArray(body.favourites)) {
        error(res, "body.favourites (array) required");
        return;
      }
      // Only entries naming a league this build knows and a team id survive. A
      // favourite for a league that no longer exists would make every poll ask
      // for a path ESPN does not serve.
      const favourites = (body.favourites as ScoreFavourite[]).filter(
        (f) => f && typeof f.teamId === "string" && f.teamId !== "" && leagueById(f.league),
      );
      // No explicit re-apply here. setFavourites announces on
      // "scores:favourites-changed", and integration-manager answers that
      // channel by re-applying and re-sending the states frame — see
      // setupListRefreshers there, and setup-list-broadcasts.test.ts. The
      // announcement was added to REPLACE this route's own call, which was
      // never deleted, so every save applied the change twice.
      //
      // Through the manager either way, never scoresService.configure(): the
      // applier is what honours the enabled flag, and configuring the service
      // straight from here would start polling for an operator who switched
      // scores off.
      const saved = await scoresStore.setFavourites(favourites);
      json(res, saved);
      return;
    }
    if (method === "GET" && pathname === "/api/scores/teams") {
      const league = c.url.searchParams.get("league") ?? "";
      const meta = leagueById(league);
      if (!meta) {
        error(res, `Unknown league ${JSON.stringify(league)}`);
        return;
      }
      try {
        json(res, await scoresService.listTeams(meta.id));
      } catch (err) {
        // 502, not an empty list. An empty dropdown and a failed request look
        // identical to the operator, and the panel is required to say which
        // league could not be loaded.
        error(res, errorMessage(err), 502);
      }
      return;
    }

    if (method === "GET" && pathname === "/api/resi/status") {
      json(res, resiService.getLatest());
      return;
    }

    if (method === "GET" && pathname === "/api/youtube/status") {
      json(res, youtubeService.getLatest());
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
        error(res, errorMessage(err), 502);
      }
      return;
    }
    if (method === "GET" && pathname === "/api/sensource/zones") {
      try {
        json(res, await integrationManager.getSensourceZones());
      } catch (err) {
        error(res, errorMessage(err), 502);
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
    // NOT under /api/spl/history/… — that path is matched by the per-service
    // regex below, where "current" already needs excluding by name. One more
    // reserved word in a path that otherwise holds service keys is a trap for
    // whoever adds the next one.
    if (method === "GET" && pathname === "/api/spl/summary") {
      json(res, await splHistoryStore.summary());
      return;
    }
    if (method === "GET" && pathname === "/api/spl/trend") {
      json(res, await splHistoryStore.getTrendPrefs());
      return;
    }
    if (method === "POST" && pathname === "/api/spl/trend") {
      const body = (await readBody(req)) as Record<string, unknown>;
      json(res, await splHistoryStore.setTrendPrefs(body));
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
          // All three records, not just SPL — see deleteServiceRecords.
          json(res, await deleteServiceRecords(key));
          return;
        }
      }
    }

}
