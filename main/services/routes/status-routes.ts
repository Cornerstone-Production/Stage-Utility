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
import { serviceDirPath } from "../archive/archive-paths.js";
import { readArchiveRows } from "../archive/archive-rows.js";
import { bucketSecFor, bucketSeries, clampBucketSec, metricsIn, type SplBucket } from "../spl-series.js";

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
      // The raw sample series behind one record's sound chart. Matched BEFORE
      // the single-segment record route below, which cannot match a two-segment
      // path but reads as though it might.
      const seriesMatch = pathname.match(/^\/api\/spl\/history\/([^/]+)\/series$/);
      if (seriesMatch && method === "GET") {
        const key = decodeURIComponent(seriesMatch[1]);
        const metric = c.url.searchParams.get("metric") ?? "";
        const bucketSec = c.url.searchParams.get("bucketSec");
        const out = await splSeriesFor(key, metric, bucketSec == null ? 5 : Number(bucketSec));
        if (!out) {
          // 404, not an empty series: "this record has no raw rows" and "the
          // meter was silent all evening" are different answers, and the chart
          // falls back to the per-item step only for the first.
          error(res, "no raw SPL rows for this service", 404);
          return;
        }
        json(res, out);
        return;
      }
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

/** What GET /api/spl/history/:key/series answers with. */
interface SplSeriesResponse {
  serviceKey: string;
  /** The metric actually plotted — the one asked for when the rows carry it,
   *  else the record's own preferred metric, else the first recorded. */
  metric: string;
  /** Every metric these rows carry, so the caller can offer a switch without a
   *  second request. */
  metrics: string[];
  /** The bucket width used, which may be WIDER than the one asked for. */
  bucketSec: number;
  buckets: SplBucket[];
}

/**
 * One record's raw SPL rows, down-sampled for a chart.
 *
 * Null — a 404 to the caller — when the record is unknown or has no raw rows at
 * all. That is a real distinction: a service recorded before the raw layer
 * existed, or one whose archive was pruned, has a per-item record and nothing to
 * draw a line from, and the chart falls back to a per-item step for exactly that
 * case. A record whose rows exist but hold nothing for the asked-for metric is
 * NOT a 404 — it answers with the metrics it does have and an empty series.
 */
async function splSeriesFor(
  serviceKey: string,
  metric: string,
  bucketSec: number,
): Promise<SplSeriesResponse | null> {
  const record = await splHistoryStore.get(serviceKey);
  if (!record) return null;
  const rows = await readArchiveRows(serviceDirPath(serviceKey, record.serviceDate), "spl");
  if (!rows || rows.length === 0) return null;

  const metrics = metricsIn(rows);
  if (metrics.length === 0) return null;
  const chosen = metrics.includes(metric)
    ? metric
    : record.metricKey && metrics.includes(record.metricKey)
      ? record.metricKey
      : metrics[0];

  const stamps = rows.map((r) => Date.parse(r.at ?? "")).filter((t) => Number.isFinite(t));
  const span = stamps.length ? Math.max(...stamps) - Math.min(...stamps) : 0;
  const width = bucketSecFor(span, clampBucketSec(bucketSec));
  return {
    serviceKey,
    metric: chosen,
    metrics,
    bucketSec: width,
    buckets: bucketSeries(rows, chosen, width),
  };
}
