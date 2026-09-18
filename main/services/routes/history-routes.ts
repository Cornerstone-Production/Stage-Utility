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
import { clockOf } from "../app-timezone.js";
import { scrub } from "../scrub.js";
import {
  deleteServiceRecords,
  editServiceWindow,
  mergeServiceRecords,
  rebuildServiceRecords,
  recalcAttendance,
  setItemCounted,
  setItemTimes,
} from "../history-edit.js";
import { broadcastTimeline, overlaidTimeline } from "../history-item-times.js";
import { historyMilestonesStore } from "../history-milestones-store.js";

/**
 * Every service type id that has a SERVICE the Trends chart draws, for
 * validating a milestone's scope.
 *
 * From the recorded history rather than from Planning Center: a milestone is
 * about what was RECORDED, and a type PCO has since renamed or removed still
 * has recordings the chart draws.
 *
 * The SPL store is deliberately NOT consulted. The chart's series are built
 * from `rows` — the union of timeline and attendance records — so a type with
 * sound and neither of those has no line for a mark to be scoped to, and
 * accepting it would store a milestone that could never appear. That is the
 * exact failure this check exists to prevent, so the two stores read here are
 * the two the chart itself reads, and the refusal says so rather than claiming
 * the type "has never recorded" when it may well have recorded sound.
 */
async function recordedServiceTypeIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const rec of await serviceTimelineStore.list()) {
    if (rec.serviceTypeId) ids.add(rec.serviceTypeId);
  }
  for (const rec of await attendanceStore.list()) {
    if (rec.serviceTypeId) ids.add(rec.serviceTypeId);
  }
  return [...ids];
}

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
    // Recompute all three summaries from the raw rows. Throws rather than
    // reporting a partial success, and the dispatcher maps that: 409 while the
    // service is still recording (ServiceIsLiveError), 500 with the reason
    // otherwise. See rebuildServiceRecords.
    if (method === "POST" && pathname === "/api/history/rebuild") {
      const body = await readBodyOrEmpty(req);
      if (typeof body.serviceKey !== "string") {
        error(res, "body.serviceKey (string) required");
        return;
      }
      json(res, await rebuildServiceRecords(body.serviceKey));
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
    // Correct ONE run of ONE item's recorded start/end. Keyed by sequence as well
    // as id because an item can run twice in a record and a timing is a statement
    // about one run, not about the plan item (unlike item-counted above).
    //
    // An ABSENT field leaves that override alone; an explicit null clears it.
    // Answers the updated record so the panel renders the effective times
    // without a second read.
    if (method === "POST" && pathname === "/api/history/item-times") {
      const body = await readBodyOrEmpty(req);
      if (
        typeof body.serviceKey !== "string" ||
        typeof body.itemId !== "string" ||
        typeof body.sequence !== "number"
      ) {
        error(res, "body.serviceKey + body.itemId (strings) and body.sequence (number) required");
        return;
      }
      const times: { startedAt?: string | null; endedAt?: string | null } = {};
      for (const field of ["startedAt", "endedAt"] as const) {
        if (!(field in body)) continue;
        const v = body[field];
        if (v !== null && typeof v !== "string") {
          error(res, `body.${field} must be an ISO string, or null to clear it`);
          return;
        }
        times[field] = v;
      }
      json(res, await setItemTimes(body.serviceKey, body.itemId, body.sequence, times));
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
    // ── Milestones: the operator's own dates marked under the Trends chart ──
    //
    // A plain list, not per-service: a milestone is a statement about the
    // history, not about one recording. The chart derives its OTHER marks (a
    // series title changing between consecutive recordings) itself and stores
    // nothing — see the store's header.
    if (method === "GET" && pathname === "/api/history/milestones") {
      json(res, historyMilestonesStore.all());
      return;
    }
    if (method === "POST" && pathname === "/api/history/milestones") {
      const body = await readBodyOrEmpty(req);
      if (typeof body.date !== "string" || typeof body.label !== "string") {
        error(res, "body.date + body.label (strings) required");
        return;
      }
      try {
        json(res, await historyMilestonesStore.save(
          {
            id: typeof body.id === "string" ? body.id : undefined,
            date: body.date,
            label: body.label,
            serviceTypeId: typeof body.serviceTypeId === "string" ? body.serviceTypeId : null,
          },
          // Every type the recorded history actually holds. A mark scoped to
          // anything else draws on no line at all and would be invisible with
          // no way to tell why.
          await recordedServiceTypeIds(),
        ));
      } catch (err) {
        // The store REFUSES a milestone it cannot draw — a date that is not a
        // day, a blank or over-long label, a service type nothing has recorded
        // — rather than storing one the operator would never see a mark for.
        // Returned, not swallowed: the form says why.
        error(res, errorMessage(err));
      }
      return;
    }
    {
      const msMatch = pathname.match(/^\/api\/history\/milestones\/([^/]+)$/);
      if (msMatch && method === "DELETE") {
        const left = await historyMilestonesStore.remove(decodeURIComponent(msMatch[1]));
        // 404 for an id that is not there. A 200 said the deletion happened, so
        // a client working from a stale list — two tabs, or a restored backup —
        // was told it had removed something that was never there.
        if (left == null) {
          error(res, "no milestone with that id", 404);
          return;
        }
        json(res, left);
        return;
      }
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
      const live = serviceTimelineRecorder.getCurrent();
      json(res, live && overlaidTimeline(live));
      return;
    }
    if (method === "POST" && pathname === "/api/service-timeline/current/reset-pacing") {
      // Mutates the SAME object the recorder holds (getCurrent() returns
      // `this.current`, not a copy), so the next debounced persist writes this
      // change too — no forget()/re-fetch dance, unlike the post-hoc edits in
      // history-edit.ts, which operate on a record the recorder has already
      // finalised and would otherwise overwrite with its own stale copy.
      const current = serviceTimelineRecorder.getCurrent();
      if (!current || current.endedAt != null) {
        error(res, "No service is live right now — pacing can only be reset while one is recording.", 409);
        return;
      }
      const nowIso = new Date().toISOString();
      current.pacingResetAt = nowIso;
      await serviceTimelineStore.upsert(current);
      broadcastTimeline(current);
      console.log(
        `[service-timeline] pacing reset by operator at ${scrub(clockOf(Date.now()))} — items before it no longer count toward pacing`,
      );
      json(res, overlaidTimeline(current));
      return;
    }
    if (method === "GET" && pathname === "/api/service-timeline") {
      json(res, (await serviceTimelineStore.list()).map((r) => overlaidTimeline(r)));
      return;
    }
    {
      const tlMatch = pathname.match(/^\/api\/service-timeline\/([^/]+)$/);
      if (tlMatch && tlMatch[1] !== "current") {
        const key = decodeURIComponent(tlMatch[1]);
        if (method === "GET") {
          const rec = await serviceTimelineStore.get(key);
          json(res, rec && overlaidTimeline(rec));
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
      try {
        json(res, await stageController.listPlanAttachments());
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

    // Full rundown of the current plan (items + note columns) for the script /
    // SPL-rundown dashboards.
    if (method === "GET" && pathname === "/api/pco/plan-items") {
      try {
        json(res, await stageController.listCurrentPlanItems());
      } catch (err) {
        error(res, errorMessage(err), 502);
      }
      return;
    }

    // The pre-service checklist, read from the plan's notes.
    if (method === "GET" && pathname === "/api/pco/checklist") {
      try {
        json(res, await stageController.listPlanChecklist());
      } catch (err) {
        error(res, errorMessage(err), 502);
      }
      return;
    }

    // The categories and teams this service type offers, for the settings picker.
    if (method === "GET" && pathname === "/api/pco/checklist-sources") {
      try {
        json(res, await stageController.listChecklistSources());
      } catch (err) {
        error(res, errorMessage(err), 502);
      }
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
