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
const { splHistoryStore } = await import("../spl-history-store.js");
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

/** Six 1 Hz readings across the two items, as the meter reported them. The
 *  rebuilt max and Leq are computed from exactly these, so a stored record
 *  carrying different numbers proves the rebuild really ran. */
const SPL_CSV = [
  "at,itemId,item,SPL A Slow",
  "2026-09-17T23:23:50.000Z,pco-1,Doors,80",
  "2026-09-17T23:23:51.000Z,pco-1,Doors,84",
  "2026-09-17T23:23:52.000Z,pco-1,Doors,88",
  "2026-09-17T23:30:10.000Z,pco-2,10 min Warning,90",
  "2026-09-17T23:30:11.000Z,pco-2,10 min Warning,96",
  "",
].join("\n");

/** An SPL record that DISAGREES with spl.csv on every number — one item where
 *  the raw rows have two, and aggregates nothing could derive from them. */
function corruptedSpl() {
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
    meterId: "m1",
    metricKey: "SPL A Slow",
    items: [
      {
        itemId: "pco-1",
        title: "Doors",
        itemType: "item",
        sequence: 0,
        metrics: { "SPL A Slow": { max: 131, avg: null, leq: 131, count: 999 } },
        maxSpl: 131,
        leqSpl: 131,
        sampleCount: 999,
        startedAt: "2026-09-17T23:23:48.789Z",
        endedAt: ENDED,
      },
    ],
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
  await splHistoryStore.delete(KEY); // the SPL leg is opted into per test
}

/** Add the SPL half: a record that disagrees with its own raw samples. */
async function seedSpl(): Promise<void> {
  await fs.writeFile(path.join(serviceDirPath(KEY, DATE), "spl.csv"), SPL_CSV, "utf8");
  await splHistoryStore.upsert(corruptedSpl() as never);
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
      // No baptism.csv for this fixture at all — see baptism-rebuild-route.test.ts
      // and rebuild-baptism-merge.test.ts for the baptism leg itself.
      baptism: { rebuilt: false, items: 0, missing: true },
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

  // The SPL leg was unguarded: deleting it from rebuildServiceRecords left the
  // whole suite green, because nothing here had an SPL record at all.
  it("recomputes the SPL aggregates from spl.csv, on disk", async () => {
    await seedSpl();

    const out = await callRoute(historyRoutes, "/api/history/rebuild", {
      method: "POST",
      body: { serviceKey: KEY },
    });

    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    assert.deepEqual((out.json as { spl: unknown }).spl, { rebuilt: true, items: 2, missing: false });

    const spl = await splHistoryStore.get(KEY);
    assert.ok(spl, "the SPL record vanished");
    assert.equal(spl.items.length, 2, "the second item never came back from the raw rows");

    const [doors, warning] = spl.items;
    assert.equal(doors.itemId, "pco-1");
    assert.equal(doors.title, "Doors");
    assert.equal(doors.sampleCount, 3, "the stored 999 survived the rebuild");
    assert.equal(doors.maxSpl, 88, "the stored max of 131 survived the rebuild");
    assert.equal(doors.metrics["SPL A Slow"].count, 3);
    assert.equal(doors.metrics["SPL A Slow"].max, 88);
    // An ENERGY average of 80/84/88 dB, not the arithmetic 84 — the whole point
    // of re-deriving from the samples rather than trusting the stored fold.
    assert.equal(Math.round(doors.leqSpl as number), 85);
    assert.equal(warning.itemId, "pco-2");
    assert.equal(warning.sampleCount, 2);
    assert.equal(warning.maxSpl, 96);
    assert.equal(warning.startedAt, "2026-09-17T23:30:10.000Z");

    assert.ok(broadcasts.includes("spl:history"), `no SPL broadcast: ${broadcasts.join(",")}`);
  });

  // The operator's "this item does not count" is a statement about the PLAN
  // item, so it survives a rebuild and reaches every run of it. Driven through
  // the real POST /api/history/item-counted, because what marks the override as
  // the operator's is that route — a test that set the flag by hand would prove
  // only that the rebuild reads a field the test wrote.
  it("keeps an operator's counted override across a rebuild, on every run of the item", async () => {
    // Two runs of Doors, more than SERVICE_GAP_MS apart.
    await fs.writeFile(
      path.join(serviceDirPath(KEY, DATE), "events.csv"),
      [
        "at,source,kind,detail",
        "2026-09-17T23:23:48.789Z,pco,item,Doors",
        "2026-09-17T23:30:04.452Z,pco,item,MESSAGE",
        "2026-09-17T23:50:00.000Z,pco,item,Doors",
        "",
      ].join("\n"),
      "utf8",
    );

    const set = await callRoute(historyRoutes, "/api/history/item-counted", {
      method: "POST",
      body: { serviceKey: KEY, itemId: "pco-1", counted: false },
    });
    assert.equal(set.status, 200, `the override was not accepted: ${set.body}`);

    const out = await callRoute(historyRoutes, "/api/history/rebuild", {
      method: "POST",
      body: { serviceKey: KEY },
    });
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);

    const tl = await serviceTimelineStore.get(KEY);
    const doors = (tl?.items ?? []).filter((i) => i.itemId === "pco-1");
    assert.equal(doors.length, 2, `expected two runs of Doors: ${JSON.stringify(tl?.items.map((i) => i.title))}`);
    assert.deepEqual(
      doors.map((i) => [i.counted, i.countedByOperator]),
      [
        [false, true],
        [false, true],
      ],
      "the operator's override did not survive the rebuild on both runs",
    );
    // And the item they did NOT exclude is untouched.
    assert.equal(tl?.items.find((i) => i.title === "MESSAGE")?.counted, undefined);
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
      baptism: { rebuilt: false, items: 0, missing: true },
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
    assert.match((thrown as Error).message, /could not be rebuilt, and nothing was changed/);
    // The reason goes to the log, never to the caller: a filesystem error names
    // an absolute path and this message reaches a LAN-visible page.
    assert.doesNotMatch((thrown as Error).message, /\//, `a path leaked into the response: ${(thrown as Error).message}`);
  });

  // Derive everything, then write. Interleaving the two left a service
  // half-rebuilt with no record of which half.
  describe("a write that fails", () => {
    it("changes nothing and reports no path when it is the FIRST write", async () => {
      const real = serviceTimelineStore.upsert.bind(serviceTimelineStore);
      serviceTimelineStore.upsert = async () => {
        throw new Error("EACCES: permission denied, open '/var/data/service-timeline.json'");
      };
      let thrown: unknown;
      try {
        await callRoute(historyRoutes, "/api/history/rebuild", { method: "POST", body: { serviceKey: KEY } });
      } catch (err) {
        thrown = err;
      } finally {
        serviceTimelineStore.upsert = real;
      }

      assert.ok(thrown, "a failed write answered as though it had succeeded");
      assert.equal(handlerErrorStatus(thrown), 500);
      assert.doesNotMatch(
        (thrown as Error).message,
        /var\/data|EACCES/,
        `the filesystem error reached the response body: ${(thrown as Error).message}`,
      );
      // Nothing landed: attendance comes after the timeline and must not have
      // been written either.
      const att = await attendanceStore.get(KEY);
      assert.equal(att?.peakOccupancy, 0, "a later record was written after an earlier one failed");
      assert.equal(broadcasts.length, 0, "a failed rebuild broadcast anyway");
    });

    it("answers 200 naming the failed record when an earlier write already landed", async () => {
      const real = attendanceStore.upsert.bind(attendanceStore);
      attendanceStore.upsert = async () => {
        throw new Error("ENOSPC: no space left on device, write '/var/data/attendance.json'");
      };
      let out;
      try {
        out = await callRoute(historyRoutes, "/api/history/rebuild", {
          method: "POST",
          body: { serviceKey: KEY },
        });
      } finally {
        attendanceStore.upsert = real;
      }

      // 200, not 500: the timing record WAS rebuilt and saved, and a bare 500
      // would tell the operator nothing happened when half of it did.
      assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
      const json = out.json as { attendance: { rebuilt: boolean }; timeline: { rebuilt: boolean }; failed: string[] };
      assert.deepEqual(json.failed, ["attendance"]);
      assert.equal(json.timeline.rebuilt, true, "the record that DID save is not reported as saved");
      assert.equal(json.attendance.rebuilt, false, "a record that failed to save is reported as rebuilt");
      assert.doesNotMatch(out.body, /ENOSPC|var\/data/, `a filesystem error reached the response body: ${out.body}`);
      // The timeline really landed.
      assert.equal((await serviceTimelineStore.get(KEY))?.items.length, 3);
    });

    it("leaves the store's cached attendance record unmutated when its write fails", async () => {
      const real = attendanceStore.upsert.bind(attendanceStore);
      attendanceStore.upsert = async () => {
        throw new Error("ENOSPC: no space left on device");
      };
      try {
        await callRoute(historyRoutes, "/api/history/rebuild", { method: "POST", body: { serviceKey: KEY } });
      } finally {
        attendanceStore.upsert = real;
      }

      // recomputeAttendance mutates in place, and the store hands back the
      // instance it caches — so recomputing the cached object left every reader
      // in this process looking at numbers that were never saved.
      const att = await attendanceStore.get(KEY);
      assert.equal(att?.peakOccupancy, 0, "the cached record was recomputed despite the write failing");
      assert.equal(att?.minOccupancy, null, "the cached record was recomputed despite the write failing");
    });
  });

  // The whole-service rebuild's own baptism leg — the merge rule itself
  // (matched/added/kept, the skew tolerance, never a delete) is
  // rebuild-baptism-merge.test.ts's job; this proves History's own
  // /api/history/rebuild actually reaches it and reports it as one of the
  // legs, per Ruling 5: "History's existing rebuild result shows the new
  // baptism leg."
  describe("the baptism leg", () => {
    const BAPTISM_CSV = [
      "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail",
      "2026-09-17T23:50:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-17T23:52:00.000Z,testimony-end,per-person,testimony,1,0,120000,,,",
      "2026-09-17T23:52:00.000Z,finish,per-person,testimony,1,0,0,,,",
      "",
    ].join("\n");

    beforeEach(async () => {
      const { baptismStore } = await import("../baptism-store.js");
      for (const s of (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY)) {
        await baptismStore.deleteSession(s.id);
      }
    });

    it("merges a session from baptism.csv alongside the other three legs", async () => {
      await fs.writeFile(path.join(serviceDirPath(KEY, DATE), "baptism.csv"), BAPTISM_CSV, "utf8");

      const out = await callRoute(historyRoutes, "/api/history/rebuild", {
        method: "POST",
        body: { serviceKey: KEY },
      });

      assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
      const json = out.json as { baptism: { rebuilt: boolean; items: number; missing: boolean } };
      assert.deepEqual(json.baptism, { rebuilt: true, items: 1, missing: false });

      const { baptismStore } = await import("../baptism-store.js");
      const sessions = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);
      assert.equal(sessions.length, 1, "the session merged by the whole-service rebuild did not land");
      assert.equal(sessions[0]!.people[0]!.testimonyMs, 120_000);

      await fs.rm(path.join(serviceDirPath(KEY, DATE), "baptism.csv"), { force: true });
    });
  });
});
