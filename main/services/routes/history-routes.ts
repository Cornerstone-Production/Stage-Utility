// history-routes.ts — Attendance, service timeline, baptism
//
// Recorded service history: attendance counts, actual rundown timing, and
// the baptism timer.
//
// Extracted verbatim from remote-server.ts's route chain; a bare `return` still
// means "handled, stop" (see RouteCtx). Ordering within this module is preserved.

import { type RouteCtx, json, error, readBody, readBodyOrEmpty } from "./context.js";
import { errorMessage } from "../errors.js";
import { baptismTriggersStore } from "../baptism-triggers-store.js";
import { stageController } from "../stage-controller.js";
import { attendanceStore } from "../attendance-store.js";
import { attendanceRecorder } from "../attendance-recorder.js";
import { serviceTimelineStore } from "../service-timeline-store.js";
import { serviceTimelineRecorder } from "../service-timeline-recorder.js";
import { baptismTimerService } from "../baptism-timer-service.js";
import {
  deleteServiceRecords,
  editServiceWindow,
  mergeServiceRecords,
  recalcAttendance,
  setItemCounted,
} from "../history-edit.js";

export async function historyRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;
    // ── Attendance history (mirrors the SPL history routes) ─────────────────
    if (method === "POST" && pathname === "/api/history/window") {
      const body = await readBodyOrEmpty(req);
      if (typeof body.serviceKey !== "string") {
        error(res, "body.serviceKey (string) required");
        return;
      }
      await editServiceWindow(body.serviceKey, {
        startedAt: typeof body.startedAt === "string" ? body.startedAt : undefined,
        endedAt: typeof body.endedAt === "string" ? body.endedAt : undefined,
      });
      json(res, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/history/recalc") {
      const body = await readBodyOrEmpty(req);
      if (typeof body.serviceKey !== "string") {
        error(res, "body.serviceKey (string) required");
        return;
      }
      await recalcAttendance(body.serviceKey);
      json(res, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/history/item-counted") {
      const body = await readBodyOrEmpty(req);
      if (typeof body.serviceKey !== "string" || typeof body.itemId !== "string" || typeof body.counted !== "boolean") {
        error(res, "body.serviceKey, body.itemId (strings) + body.counted (boolean) required");
        return;
      }
      await setItemCounted(body.serviceKey, body.itemId, body.counted);
      json(res, { ok: true });
      return;
    }
    if (method === "POST" && pathname === "/api/history/merge") {
      const body = await readBodyOrEmpty(req);
      if (typeof body.sourceKey !== "string" || typeof body.targetKey !== "string") {
        error(res, "body.sourceKey + body.targetKey (strings) required");
        return;
      }
      // Return WHAT happened, not just that it happened. A merge can legitimately
      // touch only some of the three stores, and "ok: true" made a partial result
      // indistinguishable from a complete one.
      const outcome = await mergeServiceRecords(body.sourceKey, body.targetKey);
      json(res, { ok: true, ...outcome });
      return;
    }
    if (method === "GET" && pathname === "/api/attendance/history/current") {
      json(res, attendanceRecorder.getCurrent());
      return;
    }
    if (method === "GET" && pathname === "/api/attendance/history") {
      json(res, await attendanceStore.list());
      return;
    }
    {
      const attMatch = pathname.match(/^\/api\/attendance\/history\/([^/]+)$/);
      if (attMatch && attMatch[1] !== "current") {
        const key = decodeURIComponent(attMatch[1]);
        if (method === "GET") {
          json(res, await attendanceStore.get(key));
          return;
        }
        if (method === "DELETE") {
          json(res, await deleteServiceRecords(key));
          return;
        }
      }
    }

    // ── Service timeline (actual rundown timing; mirrors the SPL/attendance routes) ──
    if (method === "GET" && pathname === "/api/service-timeline/current") {
      json(res, serviceTimelineRecorder.getCurrent());
      return;
    }
    if (method === "GET" && pathname === "/api/service-timeline") {
      json(res, await serviceTimelineStore.list());
      return;
    }
    {
      const tlMatch = pathname.match(/^\/api\/service-timeline\/([^/]+)$/);
      if (tlMatch && tlMatch[1] !== "current") {
        const key = decodeURIComponent(tlMatch[1]);
        if (method === "GET") {
          json(res, await serviceTimelineStore.get(key));
          return;
        }
        if (method === "DELETE") {
          json(res, await deleteServiceRecords(key));
          return;
        }
      }
    }

    // ── Baptism timer ───────────────────────────────────────────────────────
    if (method === "GET" && pathname === "/api/baptism") {
      json(res, baptismTimerService.getState());
      return;
    }
    if (method === "GET" && pathname === "/api/baptism/sessions") {
      json(res, await baptismTimerService.listSessions());
      return;
    }
    // Which plan items start each phase, for one plan. Kept per plan because the
    // baptisms usually happen during a song, and the songs change every week.
    if (pathname === "/api/baptism/triggers") {
      const planId = new URL(req.url ?? "", "http://x").searchParams.get("planId");
      if (method === "GET") {
        json(res, (await baptismTriggersStore.get(planId)) ?? {});
        return;
      }
      if (method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const id = typeof body.planId === "string" ? body.planId : planId;
        if (!id) {
          json(res, { error: "planId required" }, 400);
          return;
        }
        await baptismTriggersStore.set(id, {
          testimonyItemId: typeof body.testimonyItemId === "string" ? body.testimonyItemId : null,
          baptismItemId: typeof body.baptismItemId === "string" ? body.baptismItemId : null,
        });
        json(res, await baptismTriggersStore.get(id));
        return;
      }
    }
    if (method === "POST" && pathname.startsWith("/api/baptism/")) {
      const action = pathname.slice("/api/baptism/".length);
      switch (action) {
        case "start": json(res, baptismTimerService.start()); return;
        case "baptized": json(res, baptismTimerService.baptized()); return;
        case "start-baptisms": json(res, baptismTimerService.startBaptisms()); return;
        case "next": json(res, baptismTimerService.next()); return;
        case "undo": json(res, baptismTimerService.undo()); return;
        case "finish": json(res, baptismTimerService.finish()); return;
        case "pause": json(res, baptismTimerService.pause()); return;
        case "resume": json(res, baptismTimerService.resume()); return;
        case "reset": json(res, baptismTimerService.reset()); return;
        case "mode": {
          const body = (await readBody(req)) as Record<string, unknown>;
          json(res, baptismTimerService.setMode(body.mode === "grouped" ? "grouped" : "per-person"));
          return;
        }
      }
    }
    {
      const bapSessionMatch = pathname.match(/^\/api\/baptism\/sessions\/([^/]+)$/);
      if (bapSessionMatch && method === "DELETE") {
        json(res, { deleted: await baptismTimerService.deleteSession(decodeURIComponent(bapSessionMatch[1])) });
        return;
      }
    }

    // List the current plan's attachments (powers the layout editor's file picker).
    if (method === "GET" && pathname === "/api/pco/attachments") {
      json(res, await stageController.listPlanAttachments());
      return;
    }

    // Full rundown of the current plan (items + note columns) for the script /
    // SPL-rundown dashboards.
    if (method === "GET" && pathname === "/api/pco/plan-items") {
      json(res, await stageController.listCurrentPlanItems());
      return;
    }

    // The pre-service checklist, read from the plan's notes.
    if (method === "GET" && pathname === "/api/pco/checklist") {
      json(res, await stageController.listPlanChecklist());
      return;
    }

    // The categories and teams this service type offers, for the settings picker.
    if (method === "GET" && pathname === "/api/pco/checklist-sources") {
      json(res, await stageController.listChecklistSources());
      return;
    }

    // POST /api/pco/checklist/tick — { key, done }
    // Awaited before the response: a tick that looked saved and was not is how
    // somebody skips a job on Sunday believing it was done.
    if (method === "POST" && pathname === "/api/pco/checklist/tick") {
      const body = await readBody(req) as Record<string, unknown>;
      if (typeof body.key !== "string" || typeof body.done !== "boolean") {
        error(res, "body.key (string) and body.done (boolean) required");
        return;
      }
      try {
        json(res, await stageController.setChecklistTick(body.key, body.done));
      } catch (err) {
        error(res, errorMessage(err));
      }
      return;
    }

    // POST /api/pco/checklist/clear — start this week's list over.
    if (method === "POST" && pathname === "/api/pco/checklist/clear") {
      try {
        json(res, await stageController.clearChecklistTicks());
      } catch (err) {
        error(res, errorMessage(err));
      }
      return;
    }

}
