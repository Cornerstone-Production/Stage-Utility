// A stored attendance record is never rewritten by being read.
//
// Imports and History merges now put two recordings into one frame before they
// combine them. Records already on disk were combined the old way, and some of
// them are saw-toothed: two boxes' series interleaved twenty people apart. They
// stay exactly as they are until an operator edits or merges them. Re-aligning
// them is a repair, and a repair of an operator's data is an explicit, logged
// action with a kept copy, never a side effect of opening History. The read
// paths a page, an archive export and a spreadsheet export take are walked
// here, and the bytes on disk must not move. (No boot path touches attendance
// frames: reconcile-records.ts closes open records and does not import
// attendance-aggregate.ts.)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-attendance-at-rest-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import type { ServiceAttendance } from "../types/history.js";

const { attendanceStore } = await import("./attendance-store.js");
const { historyRoutes } = await import("./routes/history-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { buildArchive, inspectArchive } = await import("./archive/archive-bundle.js");
const { buildHistoryWorkbook } = await import("./history-export.js");

const KEY = "st1:p1:9am";
const T9 = Date.parse("2026-10-18T09:00:00.000Z");

/** What an import made of two boxes' recordings before frames were aligned: A's
 *  samples on the minute, B's seven seconds later and twenty people low. */
function sawTooth(): ServiceAttendance {
  const samples = [];
  for (let m = 0; m <= 20; m++) {
    samples.push({ t: new Date(T9 + m * 60_000).toISOString(), attendance: 2 * m, occupancy: 300 });
    if (m >= 10) samples.push({ t: new Date(T9 + m * 60_000 + 7000).toISOString(), attendance: 2 * m - 20, occupancy: 300 });
  }
  return {
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "p1",
    planTitle: "Sunday",
    seriesTitle: null,
    serviceDate: "2026-10-18",
    serviceTimeId: "9am",
    serviceTimeStartsAt: null,
    startedAt: new Date(T9).toISOString(),
    serviceStartedAt: new Date(T9).toISOString(),
    endedAt: new Date(T9 + 20 * 60_000).toISOString(),
    samples,
    attendanceBaseline: 500,
    totalAttendance: 540,
    peakAttendance: 40,
    peakOccupancy: 300,
    minOccupancy: 300,
    lastAttendance: 40,
    lastOccupancy: 300,
  };
}

/** Every file under the store's directory: name, bytes and modification time. */
async function snapshot(): Promise<Map<string, { bytes: string; mtimeMs: number }>> {
  const dir = path.join(TMP, "attendance-history");
  const out = new Map<string, { bytes: string; mtimeMs: number }>();
  for (const name of (await fs.readdir(dir, { recursive: true })).sort()) {
    const full = path.join(dir, name);
    const st = await fs.stat(full);
    if (st.isFile()) out.set(name, { bytes: await fs.readFile(full, "utf8"), mtimeMs: st.mtimeMs });
  }
  return out;
}

describe("a saw-toothed attendance record already on disk", () => {
  it("is left byte-identical by every read", async () => {
    await attendanceStore.upsert(sawTooth());
    const before = await snapshot();
    assert.equal(before.size, 1, [...before.keys()].join(", "));

    // From cold, the way a restarted server first meets it.
    attendanceStore.invalidate();
    assert.equal((await attendanceStore.get(KEY))?.samples.length, 32);
    await attendanceStore.list();
    for (const route of [
      "/api/attendance/history?summary=1",
      "/api/attendance/history",
      `/api/attendance/history/${encodeURIComponent(KEY)}`,
    ]) {
      const out = await callRoute(historyRoutes, route);
      assert.equal(out.status, 200, `${route} answered ${out.status}`);
    }
    await inspectArchive(await buildArchive());
    await buildHistoryWorkbook({ include: ["services", "attendance"] });

    assert.deepEqual(await snapshot(), before);
  });
});
