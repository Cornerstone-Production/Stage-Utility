// system-routes.ts — Self-update + config snapshots
//
// In-app updates (check/apply/track/restart) and full config backup/restore.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error, readBody } from "./context.js";
import { stageController } from "../stage-controller.js";
import { updater } from "../updater.js";
import { backupScheduler } from "../backup-scheduler.js";
import { configSnapshot } from "../config-snapshot.js";
import { splRecorder } from "../spl-recorder.js";
import { attendanceRecorder } from "../attendance-recorder.js";
import { serviceTimelineRecorder } from "../service-timeline-recorder.js";

/** Whether a live service / active recording is in progress, and why. Used to lock
 *  self-updates (which restart the process and would interrupt a service mid-flight
 *  and drop the last un-persisted samples) unless the operator explicitly overrides. */
function serviceActivity(): { active: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (stageController.getLastLive()?.mode === "item") reasons.push("A PCO service is live");
  const spl = splRecorder.getCurrent();
  if (spl && !spl.endedAt) reasons.push("SPL is recording");
  const att = attendanceRecorder.getCurrent();
  if (att && !att.endedAt) reasons.push("Attendance is recording");
  const tl = serviceTimelineRecorder.getCurrent();
  if (tl && !tl.endedAt) reasons.push("Service history is recording");
  return { active: reasons.length > 0, reasons };
}

/** Exit shortly after replying, so the service manager restarts us. */
function scheduleRestart(): void {
  setTimeout(() => process.exit(0), 1200);
}

export async function systemRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
    // ── In-app self-update ────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/update/status") {
      json(res, updater.getStatus());
      return;
    }
    if (method === "POST" && pathname === "/api/update/check") {
      json(res, await updater.checkForUpdate());
      return;
    }
    if (method === "GET" && pathname === "/api/update/lock") {
      json(res, serviceActivity());
      return;
    }
    if (method === "POST" && pathname === "/api/update/apply") {
      const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      const lock = serviceActivity();
      if (lock.active && body.override !== true) {
        json(res, { error: "locked", locked: true, reasons: lock.reasons }, 409);
        return;
      }
      try {
        json(res, await updater.applyUpdate());
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    if (method === "POST" && pathname === "/api/update/track") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.branch !== "string") {
        error(res, "body.branch (string) required");
        return;
      }
      const lock = serviceActivity();
      if (lock.active && body.override !== true) {
        json(res, { error: "locked", locked: true, reasons: lock.reasons }, 409);
        return;
      }
      try {
        json(res, await updater.switchTrack(body.branch));
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    if (method === "POST" && pathname === "/api/update/restart") {
      try {
        json(res, updater.restart());
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    if (method === "POST" && pathname === "/api/update/auto") {
      const body = await readBody(req) as Record<string, unknown>;
      const partial: { enabled?: boolean; dayOfWeek?: number | null; hour?: number } = {};
      if (typeof body.enabled === "boolean") partial.enabled = body.enabled;
      if (body.dayOfWeek === null || typeof body.dayOfWeek === "number") partial.dayOfWeek = body.dayOfWeek;
      if (typeof body.hour === "number") partial.hour = body.hour;
      const state = await stageController.setAutoUpdate(partial);
      json(res, state);
      return;
    }
    if (method === "POST" && pathname === "/api/reconnect-schedule") {
      const body = await readBody(req) as Record<string, unknown>;
      const partial: Record<string, unknown> = {};
      if (typeof body.enabled === "boolean") partial.enabled = body.enabled;
      for (const k of ["leadMin", "tailMin", "dormantMin"]) {
        if (typeof body[k] === "number") partial[k] = body[k];
      }
      json(res, await stageController.setReconnectSchedule(partial));
      return;
    }
    if (method === "POST" && pathname === "/api/taper-window") {
      const body = await readBody(req) as Record<string, unknown>;
      const partial: Record<string, unknown> = {};
      for (const k of ["preMin", "postMin"]) {
        if (typeof body[k] === "number") partial[k] = body[k];
      }
      json(res, await stageController.setTaperWindow(partial));
      return;
    }

    // ── Config snapshot (backup / restore) ──────────────────────────────────
    // Download the full config (secrets excluded) as a .json file.
    if (method === "GET" && pathname === "/api/config/export") {
      const bundle = await configSnapshot.build();
      const fname = `stage-utility-config-${new Date().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${fname}"`,
      });
      res.end(JSON.stringify(bundle, null, 2));
      return;
    }
    // Restore an uploaded config bundle, then restart to apply.
    if (method === "POST" && pathname === "/api/config/import") {
      const body = await readBody(req) as Record<string, unknown>;
      const bundle = "bundle" in body ? body.bundle : body;
      try {
        const applied = await configSnapshot.apply(bundle);
        json(res, { ok: true, applied, restarting: true });
        scheduleRestart();
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    // ── Automatic backups ───────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/backup/schedule") {
      json(res, await backupScheduler.getSchedule());
      return;
    }
    if (method === "POST" && pathname === "/api/backup/schedule") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const partial: Record<string, unknown> = {};
      if (typeof body.enabled === "boolean") partial.enabled = body.enabled;
      if (typeof body.includeArchive === "boolean") partial.includeArchive = body.includeArchive;
      if (typeof body.destination === "string") partial.destination = body.destination;
      for (const k of ["intervalDays", "keep"]) if (typeof body[k] === "number") partial[k] = body[k];
      json(res, await backupScheduler.setSchedule(partial));
      return;
    }
    // Run one immediately — also how the operator proves the destination works.
    if (method === "POST" && pathname === "/api/backup/run") {
      json(res, await backupScheduler.runNow());
      return;
    }

    // List saved snapshots.
    if (method === "GET" && pathname === "/api/config/snapshots") {
      json(res, await configSnapshot.list());
      return;
    }
    // Save the current config as a named snapshot.
    if (method === "POST" && pathname === "/api/config/snapshots") {
      const body = await readBody(req) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : "";
      json(res, await configSnapshot.save(name), 201);
      return;
    }
    // Recall a saved snapshot (apply + restart).
    const snapRecallMatch = pathname.match(/^\/api\/config\/snapshots\/([^/]+)\/recall$/);
    if (method === "POST" && snapRecallMatch) {
      try {
        const applied = await configSnapshot.recall(snapRecallMatch[1]);
        json(res, { ok: true, applied, restarting: true });
        scheduleRestart();
      } catch (err) {
        error(res, String(err instanceof Error ? err.message : err));
      }
      return;
    }
    // Delete a saved snapshot.
    const snapDeleteMatch = pathname.match(/^\/api\/config\/snapshots\/([^/]+)$/);
    if (method === "DELETE" && snapDeleteMatch) {
      await configSnapshot.delete(snapDeleteMatch[1]);
      json(res, { ok: true });
      return;
    }

}
