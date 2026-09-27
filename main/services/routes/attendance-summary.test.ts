// GET /api/attendance/history?summary=1 is what the list pages read.
//
// History, its Trends chart and Home show only a finished record's stored
// figures, and its raw samples were about 97% of a month's download. The summary
// drops them from a finished record and keeps them on one still recording, whose
// arriving row reads its latest sample. Without the parameter the records go out
// whole, as a script calling the route has always had them. Through the real
// route and the real store.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-attendance-summary-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import type { ServiceAttendance } from "../../types/history.js";

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { attendanceStore } = await import("../attendance-store.js");

function record(serviceKey: string, endedAt: string | null): ServiceAttendance {
  return {
    serviceKey,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "p1",
    planTitle: "Sunday",
    seriesTitle: null,
    serviceDate: "2026-09-20",
    serviceTimeId: serviceKey,
    serviceTimeStartsAt: null,
    startedAt: "2026-09-20T15:00:00.000Z",
    serviceStartedAt: "2026-09-20T15:10:00.000Z",
    endedAt,
    samples: [
      { t: "2026-09-20T15:00:00.000Z", attendance: 10, occupancy: 10 },
      { t: "2026-09-20T15:00:15.000Z", attendance: 24, occupancy: 22 },
    ],
    attendanceBaseline: 0,
    totalAttendance: 24,
    peakAttendance: 24,
    peakOccupancy: 22,
    minOccupancy: 10,
    lastAttendance: 24,
    lastOccupancy: 22,
  } as ServiceAttendance;
}

await attendanceStore.upsert(record("st1:p1:done", "2026-09-20T16:20:00.000Z"));
await attendanceStore.upsert(record("st1:p1:live", null));

const byKey = (rows: unknown) => new Map((rows as ServiceAttendance[]).map((r) => [r.serviceKey, r]));

describe("the attendance list", () => {
  it("summarized, leaves a finished record's samples out and keeps its figures", async () => {
    const out = await callRoute(historyRoutes, "/api/attendance/history?summary=1");
    assert.equal(out.status, 200);
    const done = byKey(out.json).get("st1:p1:done")!;
    assert.equal(done.samples, undefined, "a finished record still carried its samples");
    assert.equal(done.peakOccupancy, 22);
    assert.equal(done.lastOccupancy, 22);
  });

  it("summarized, keeps a still-recording record's samples", async () => {
    const out = await callRoute(historyRoutes, "/api/attendance/history?summary=1");
    assert.equal(byKey(out.json).get("st1:p1:live")!.samples?.length, 2, "the arriving row lost the sample it reads");
  });

  it("without the parameter, sends every record whole", async () => {
    const out = await callRoute(historyRoutes, "/api/attendance/history");
    for (const r of byKey(out.json).values()) assert.equal(r.samples.length, 2, `${r.serviceKey} lost its samples`);
  });
});
