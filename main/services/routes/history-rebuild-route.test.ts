// POST /api/history/rebuild — recompute a recording's three summaries from the
// raw rows it was derived from.
//
// Driven end to end against a real data directory: the real stores, the real
// archive files, the real route. The whole point of the route is that the bad
// record on disk is REPLACED by one derived from events.csv, and a test with a
// stubbed store would agree with itself about that.
//
// The fixture is the 18 Sep 2026 corruption in miniature — a record whose first
// item swallowed the whole evening, over rows that say otherwise.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-rebuild-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { handlerErrorStatus } = await import("../remote-server.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");
const { attendanceStore } = await import("../attendance-store.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { serviceDirPath } = await import("../archive/archive-paths.js");
const { addBroadcastListener } = await import("../broadcaster.js");

const KEY = "st1:plan-1:t-1";
const DATE = "2026-09-17";
const ENDED = "2026-09-18T00:43:15.189Z";

/** Three transitions the recorder actually wrote, old-format (no id column). */
const EVENTS = [
  "at,source,kind,detail",
  "2026-09-17T23:23:48.789Z,pco,item,Doors",
  "2026-09-17T23:30:04.452Z,pco,item,10 min Warning",
  "2026-09-17T23:32:03.584Z,pco,item,Thank God I'm Free",
  "",
].join("\n");

/** The corrupted summary: one item, running the whole evening. */
function corruptedTimeline() {
  return {
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday Gathering",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: "t-1",
    serviceTimeStartsAt: null,
    startedAt: "2026-09-17T23:23:48.789Z",
    endedAt: ENDED,
    items: [
      {
        itemId: "pco-1",
        title: "Doors",
        sequence: 0,
        plannedLengthSec: 900,
        startedAt: "2026-09-17T23:23:48.789Z",
        endedAt: ENDED,
        actualDurationSec: 4766,
        preService: true,
      },
    ],
  };
}

function attendance() {
  return {
    serviceKey: KEY,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday Gathering",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: "t-1",
    serviceTimeStartsAt: null,
    startedAt: "2026-09-17T23:23:48.789Z",
    endedAt: ENDED,
    samples: [
      { t: "2026-09-17T23:25:00.000Z", attendance: 0, occupancy: 40 },
      { t: "2026-09-17T23:35:00.000Z", attendance: 60, occupancy: 100 },
      { t: "2026-09-17T23:45:00.000Z", attendance: 90, occupancy: 130 },
    ],
    attendanceBaseline: 0,
    totalAttendance: 90,
    peakAttendance: 0, // stale on purpose — the rebuild must correct it
    peakOccupancy: 0,
    minOccupancy: null,
    lastAttendance: 0,
    lastOccupancy: 0,
  };
}

const broadcasts: string[] = [];
addBroadcastListener((channel) => void broadcasts.push(channel));

after(async () => {
  serviceTimelineRecorder.forget(KEY);
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function seed(): Promise<void> {
  const dir = serviceDirPath(KEY, DATE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "events.csv"), EVENTS, "utf8");
  await serviceTimelineStore.upsert(corruptedTimeline() as never);
  await attendanceStore.upsert(attendance() as never);
}

describe("POST /api/history/rebuild", () => {
  beforeEach(async () => {
    broadcasts.length = 0;
    serviceTimelineRecorder.forget(KEY);
    await seed();
  });

  it("replaces the stored timing record with one derived from events.csv", async () => {
    const out = await callRoute(historyRoutes, "/api/history/rebuild", {
      method: "POST",
      body: { serviceKey: KEY },
    });

    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.deepEqual(out.json, {
      timeline: { rebuilt: true, items: 3, missing: false },
      spl: { rebuilt: false, items: 0, missing: true },
      attendance: { rebuilt: true, items: 3, missing: false },
      failed: [],
    });

    // On disk, not just in the answer.
    const tl = await serviceTimelineStore.get(KEY);
    assert.ok(tl, "the timeline record vanished");
    assert.deepEqual(
      tl.items.map((i) => [i.title, i.startedAt, i.endedAt]),
      [
        ["Doors", "2026-09-17T23:23:48.789Z", "2026-09-17T23:30:04.452Z"],
        ["10 min Warning", "2026-09-17T23:30:04.452Z", "2026-09-17T23:32:03.584Z"],
        ["Thank God I'm Free", "2026-09-17T23:32:03.584Z", ENDED],
      ],
    );
    // The old row matched the stored record by title, so the plan item's own id
    // and planned length survived the rebuild.
    assert.equal(tl.items[0].itemId, "pco-1");
    assert.equal(tl.items[0].plannedLengthSec, 900);
    // Identity untouched.
    assert.equal(tl.planTitle, "Sunday Gathering");
    assert.equal(tl.endedAt, ENDED);

    // Attendance aggregates re-derived from its samples.
    const att = await attendanceStore.get(KEY);
    assert.equal(att?.peakOccupancy, 130, "the stale peak survived the rebuild");
    assert.equal(att?.minOccupancy, 40);

    assert.ok(broadcasts.includes("service-timeline:history"), `no timeline broadcast: ${broadcasts.join(",")}`);
    assert.ok(broadcasts.includes("attendance:history"), `no attendance broadcast: ${broadcasts.join(",")}`);
  });

  it("refuses with a sentence while that service is recording", async () => {
    const held = serviceTimelineRecorder as unknown as {
      current: unknown;
      currentKey: string | null;
      lastLiveAt: number;
    };
    held.current = { serviceKey: KEY, endedAt: null, items: [] };
    held.currentKey = KEY;
    held.lastLiveAt = Date.now();

    let thrown: unknown;
    try {
      await callRoute(historyRoutes, "/api/history/rebuild", { method: "POST", body: { serviceKey: KEY } });
    } catch (err) {
      thrown = err;
    } finally {
      serviceTimelineRecorder.forget(KEY);
    }

    assert.ok(thrown, "the route did not refuse a live service");
    assert.equal(handlerErrorStatus(thrown), 409);
    assert.equal(
      (thrown as Error).message,
      "That service is recording right now — it cannot be rebuilt until it ends.",
    );
    // And nothing was written: the corrupted record is still the corrupted record.
    const tl = await serviceTimelineStore.get(KEY);
    assert.equal(tl?.items.length, 1, "a refused rebuild wrote anyway");
    assert.equal(broadcasts.length, 0, "a refused rebuild broadcast anyway");
  });

  // The defect this shape exists for: a recording whose archive directory was
  // never written answered 200 and told the operator "Rebuilt: 12 items" about
  // twelve items nothing had looked at.
  it("refuses with 409 when the recording has no raw rows at all", async () => {
    await fs.rm(serviceDirPath(KEY, DATE), { recursive: true, force: true });
    await attendanceStore.delete(KEY); // leave only the timeline, with nothing behind it
    broadcasts.length = 0;

    let thrown: unknown;
    try {
      await callRoute(historyRoutes, "/api/history/rebuild", { method: "POST", body: { serviceKey: KEY } });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "a recording with no raw rows answered as though it had rebuilt something");
    assert.equal(handlerErrorStatus(thrown), 409);
    assert.match((thrown as Error).message, /No raw rows exist for this recording/);
    assert.equal(broadcasts.length, 0, "nothing was derived, so nothing may be broadcast");
    const tl = await serviceTimelineStore.get(KEY);
    assert.equal(tl?.items.length, 1, "the untouched record was rewritten anyway");
  });

  it("says which records it left alone when only some could be derived", async () => {
    // events.csv gone, attendance still here: attendance re-derives from its own
    // samples, the timing record has nothing to re-derive from.
    await fs.rm(path.join(serviceDirPath(KEY, DATE), "events.csv"), { force: true });

    const out = await callRoute(historyRoutes, "/api/history/rebuild", {
      method: "POST",
      body: { serviceKey: KEY },
    });

    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.deepEqual(out.json, {
      timeline: { rebuilt: false, items: 1, missing: false },
      spl: { rebuilt: false, items: 0, missing: true },
      attendance: { rebuilt: true, items: 3, missing: false },
      failed: [],
    });
    // `items: 1` is the corrupted record, unchanged — and `rebuilt: false` is
    // what stops that number reading as a repair.
    const tl = await serviceTimelineStore.get(KEY);
    assert.equal(tl?.items[0].actualDurationSec, 4766, "the untouched record was rewritten anyway");
  });

  it("rejects a body with no serviceKey", async () => {
    const out = await callRoute(historyRoutes, "/api/history/rebuild", { method: "POST", body: {} });
    assert.equal(out.status, 400, `expected 400, got ${out.status}: ${out.body}`);
  });

  it("fails loudly for a key no record names a date for, rather than reporting success", async () => {
    let thrown: unknown;
    try {
      await callRoute(historyRoutes, "/api/history/rebuild", {
        method: "POST",
        body: { serviceKey: "st1:nope:t-9" },
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, "an unknown service key answered as though it had rebuilt something");
    assert.equal(handlerErrorStatus(thrown), 500);
    assert.match((thrown as Error).message, /cannot be located/);
  });
});
