// An item that goes live early for the next service does not reopen the one
// that ended.
//
// Planning Center rolls its live occurrence on to the 11am once the 9am is over.
// The recorders hold the 9am's record through that roll while the 11am is more
// than ten minutes away, because a service running long rolls the same way and
// must not be split mid-overrun. That hold also caught a service that had
// ENDED: the 9am closed, and an item put live half an hour before the 11am (a
// walk-in loop, a slide check) reopened the 9am's records and was filed there.
//
// A closed record is still held for the service it closed on: a brief mode drop
// mid-service, or the airing that was on air when it closed coming back. A new
// airing after the service ended, with the service gap passed, belongs to the
// next one.
//
// Driven through the three real recorders' onLiveTick, in live-poller.ts order,
// with the occurrence start times Planning Center reports.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { PcoLiveDTO } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-early-item-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { stageController } = await import("./stage-controller.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

type Rec = { serviceKey: string; endedAt: string | null };
type Held = {
  current: Rec | null;
  currentKey: string | null;
  lastLiveAt: number;
  stoppedAt: number;
  splitOnRamp: unknown;
  lastAiring: unknown;
  inheritedAiring: unknown;
  forget(key: string): boolean;
  getRecord(key: string): Promise<Rec | null>;
};
const RECORDERS: [string, Held][] = [
  ["spl-recorder", splRecorder as unknown as Held],
  ["attendance-recorder", attendanceRecorder as unknown as Held],
  ["service-timeline-recorder", serviceTimelineRecorder as unknown as Held],
];

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** 9am Chicago. */
const NINE = Date.parse("2026-11-08T15:00:00.000Z");
const ELEVEN = NINE + 120 * MIN;
const START = new Map([
  ["occ-a", NINE],
  ["occ-b", ELEVEN],
]);

async function tickNoItem(atMs: number, occ: string) {
  mock.timers.setTime(atMs);
  const live = {
    mode: "preservice",
    currentItemId: null,
    label: null,
    itemType: null,
    lengthSec: null,
    liveStartAt: null,
    targetAt: null,
    serverNow: iso(atMs),
    currentItemTitle: null,
    nextItemTitle: null,
    serviceTimeId: occ,
    serviceTimeStartsAt: START.has(occ) ? iso(START.get(occ)!) : null,
  } as PcoLiveDTO;
  await splRecorder.onLiveTick(live);
  await attendanceRecorder.onLiveTick(live);
  await serviceTimelineRecorder.onLiveTick(live);
}

async function tick(atMs: number, occ: string, itemId: string, opts: { since?: number; serviceEnded?: boolean } = {}) {
  mock.timers.setTime(atMs);
  const live: PcoLiveDTO = {
    mode: "item",
    currentItemId: itemId,
    label: itemId,
    itemType: "item",
    lengthSec: null,
    liveStartAt: iso(opts.since ?? atMs),
    targetAt: null,
    serverNow: iso(atMs),
    currentItemTitle: itemId,
    nextItemTitle: null,
    serviceTimeId: occ,
    serviceTimeStartsAt: START.has(occ) ? iso(START.get(occ)!) : null,
    serviceEnded: opts.serviceEnded ?? false,
    beforeServiceStart: false,
  };
  await splRecorder.onLiveTick(live);
  await attendanceRecorder.onLiveTick(live);
  await serviceTimelineRecorder.onLiveTick(live);
}

/** Planning Center on one airing from `fromMs` until `toMs`, polled every two
 *  minutes as a running service is: the recorders' gap counts from these. */
async function airs(fromMs: number, toMs: number, occ: (atMs: number) => string, itemId: string) {
  for (let at = fromMs; at <= toMs; at += 2 * MIN) await tick(at, occ(at), itemId, { since: fromMs });
}
/** The live occurrence: the 9am until its planned hour is up, then the 11am. */
const rolling = (atMs: number) => (atMs < NINE + 60 * MIN ? "occ-a" : "occ-b");

describe("after a service ends, before the next one", () => {
  let planId = "";
  let n = 0;
  let lines: string[] = [];
  const keyFor = (occ: string) => `75953:${planId}:${occ}`;

  beforeEach((t) => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    lines = captureConsole(t as TestContext, "log", "warn", "error");
    planId = `early-${++n}`;
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "Service",
      planId,
      planTitle: "Early",
      planSeriesTitle: null,
    });
    for (const [, rec] of RECORDERS) {
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
      rec.stoppedAt = 0;
      rec.splitOnRamp = null;
      // A previous test's airing would count as already on air here.
      rec.lastAiring = null;
      rec.inheritedAiring = null;
    }
  });

  afterEach(() => {
    for (const [, rec] of RECORDERS) {
      for (const occ of ["occ-a", "occ-b"]) rec.forget(keyFor(occ));
      rec.current = null;
      rec.currentKey = null;
    }
    mock.timers.tick(61_000);
    mock.timers.reset();
  });

  it("files an item put live long before the next service under the next service", async () => {
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 30 * MIN, rolling, "song");
    await airs(NINE + 32 * MIN, NINE + 68 * MIN, rolling, "message");
    const end = NINE + 70 * MIN;
    // The 9am reaches SERVICE END; Planning Center has rolled on to the 11am.
    await tick(end, "occ-b", "dismissal", { serviceEnded: true });
    await tickNoItem(end + 5 * MIN, "occ-b");
    // Forty minutes before the 11am, somebody puts the walk-in loop up.
    await tick(ELEVEN - 40 * MIN, "occ-b", "walk-in");

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-b"), `${name}: the early item reopened the service that ended`);
      const first = await rec.getRecord(keyFor("occ-a"));
      assert.equal(first?.endedAt, iso(end), `${name}: the 9am's record was reopened`);
    }
    assert.ok(
      lines.some((l) => l.includes("[service-recorder]") && l.includes("walk-in") && l.includes(keyFor("occ-a"))),
      `no [service-recorder] line says why the early item opened a new record:\n${lines.join("\n")}`,
    );
  });

  it("files it under the next service when the last one ended on a mode drop", async () => {
    // No SERVICE END: Planning Center just left item mode. Attendance is then
    // on the 11am's arrival ramp and still holds the 9am's record open, so the
    // three recorders agree only if the decision is about the service, not the
    // record.
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 30 * MIN, rolling, "song");
    await airs(NINE + 32 * MIN, NINE + 68 * MIN, rolling, "message");
    await tickNoItem(NINE + 70 * MIN, "occ-b");
    await tick(ELEVEN - 40 * MIN, "occ-b", "walk-in");

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-b"), `${name}: the early item went to the service that ended`);
      assert.ok((await rec.getRecord(keyFor("occ-a")))?.endedAt, `${name}: the 9am's record is open`);
    }
  });

  it("closes attendance at the drop, and gives the next service its own arrival ramp, once the gap has passed", async () => {
    // No SERVICE END: Planning Center left item mode fifty minutes before the
    // 11am, inside its arrival-ramp window. Attendance has no item to go on and
    // held the 9am open on the ramp until ten minutes before the 11am.
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 30 * MIN, rolling, "song");
    await airs(NINE + 32 * MIN, NINE + 68 * MIN, rolling, "message");
    const drop = NINE + 70 * MIN;
    for (let at = drop; at <= NINE + 84 * MIN; at += 2 * MIN) await tickNoItem(at, "occ-b");

    const att = RECORDERS[1]![1];
    assert.equal(att.current?.serviceKey, keyFor("occ-b"), "the 11am's arrivals are still being added to the 9am");
    assert.equal((await att.getRecord(keyFor("occ-a")))?.endedAt, iso(drop), "the 9am did not end when Planning Center left it");

    // A new airing after that is the 11am's, for all three.
    await tick(NINE + 86 * MIN, "occ-b", "walk-in");
    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-b"), `${name}: the walk-in went back to the 9am`);
    }
  });

  it("gives the next service the arrivals counted after the stop, before the split", async (t) => {
    // Attendance holds the stopped 9am for the service gap in case it comes
    // back; the arrival-ramp counts taken in that window are the 11am's.
    let raw = 1000;
    const { sensourceService } = await import("./sensource-service.js");
    t.mock.method(sensourceService, "getLatest", () => ({ connected: true, total: { attendance: raw, occupancy: 200 } }));
    const pushed: { serviceKey: string; samples: { t: string }[] }[] = [];
    let collecting = true;
    const { addBroadcastListener } = await import("./broadcaster.js");
    addBroadcastListener((channel, payload) => {
      if (collecting && channel === "attendance:history") pushed.push(structuredClone(payload) as (typeof pushed)[number]);
    });
    t.after(() => {
      collecting = false;
    });
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 30 * MIN, rolling, "song");
    await airs(NINE + 32 * MIN, NINE + 68 * MIN, rolling, "message");
    const drop = NINE + 70 * MIN;
    for (let at = drop; at <= NINE + 84 * MIN; at += 2 * MIN) {
      raw += 10; // people arriving for the 11am
      await tickNoItem(at, "occ-b");
    }

    const att = RECORDERS[1]![1] as unknown as { getRecord(k: string): Promise<{ samples: { t: string; attendance: number; phase?: string }[]; attendanceBaseline: number | null } | null> };
    // From the file, not the store's cached object: the stopped record is saved again without them.
    const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "attendance-history", `${keyFor("occ-a").replace(/[^A-Za-z0-9._-]+/g, "-")}.json`), "utf8")) as {
      samples: { t: string }[];
    };
    assert.deepEqual(onDisk.samples.filter((x) => Date.parse(x.t) >= drop).map((x) => x.t), [], "the 9am's file still holds the 11am's arrivals");
    const lastNine = pushed.filter((p) => p.serviceKey === keyFor("occ-a")).at(-1);
    assert.deepEqual(lastNine?.samples.filter((x) => Date.parse(x.t) >= drop).map((x) => x.t), [], "History was last shown the 9am with the 11am's arrivals");
    const nine = await att.getRecord(keyFor("occ-a"));
    const eleven = await att.getRecord(keyFor("occ-b"));
    assert.deepEqual(nine?.samples.filter((x) => Date.parse(x.t) >= drop).map((x) => x.t), [], "the 11am's arrivals are in the 9am");
    const ramp = eleven?.samples.filter((x) => x.phase === "pre") ?? [];
    assert.equal(ramp[0]?.t, iso(drop), "the arrivals counted after the stop are missing from the 11am");
    // Counted from the 11am's own first count, as its other samples are.
    assert.equal(ramp[0]?.attendance, 0);
    assert.ok(ramp.every((x, i) => i === 0 || x.attendance >= ramp[i - 1]!.attendance), JSON.stringify(ramp));
  });

  it("does not hold or publish the stopped record when History deletes it during its second save", async (t) => {
    const { sensourceService } = await import("./sensource-service.js");
    t.mock.method(sensourceService, "getLatest", () => ({ connected: true, total: { attendance: 1000, occupancy: 200 } }));
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 68 * MIN, rolling, "song");
    for (let at = NINE + 70 * MIN; at <= NINE + 76 * MIN; at += 2 * MIN) await tickNoItem(at, "occ-b");
    const { attendanceStore } = await import("./attendance-store.js");
    const realUpsert = attendanceStore.upsert.bind(attendanceStore);
    let saves = 0;
    t.mock.method(attendanceStore, "upsert", async (rec: { serviceKey: string }) => {
      if (rec.serviceKey === keyFor("occ-a") && ++saves === 2) {
        attendanceRecorder.forget(rec.serviceKey); // the operator's delete lands mid-save
        throw new Error("disk full");
      }
      return realUpsert(rec as never);
    });
    const pushes: string[] = [];
    let collecting = true;
    const { addBroadcastListener } = await import("./broadcaster.js");
    addBroadcastListener((channel, payload) => {
      if (collecting && channel === "attendance:history") pushes.push((payload as { serviceKey: string }).serviceKey);
    });
    t.after(() => {
      collecting = false;
    });
    await tickNoItem(NINE + 78 * MIN, "occ-b"); // the split, ten minutes after it last ran

    assert.equal(saves, 2, `the stopped record was not saved again (${saves}) ${JSON.stringify(pushes)}`);
    assert.equal(attendanceRecorder.isHolding(keyFor("occ-a")), false, "a deleted record is held to be written back");
    assert.equal(pushes.filter((k) => k === keyFor("occ-a")).length, 1, "the deleted record was published again");
  });

  it("moves only arrival counts from the stop on, re-based on the incoming record's own baseline", () => {
    type Sample = { t: string; attendance: number; occupancy: number; phase?: "pre" | "post" };
    type Att = { serviceKey: string; samples: Sample[]; attendanceBaseline: number | null };
    const stop = NINE + 70 * MIN;
    const at = (m: number, attendance: number, phase?: "pre" | "post"): Sample => ({ t: iso(NINE + m * MIN), attendance, occupancy: 100, ...(phase ? { phase } : {}) });
    const from: Att = { serviceKey: "a", attendanceBaseline: 100, samples: [at(-20, 5, "pre"), at(30, 300), at(70, 310, "pre"), at(72, 320, "post"), at(74, 330, "pre")] };
    const into: Att = { serviceKey: "b", attendanceBaseline: 400, samples: [at(90, 50)] };
    const moved = (attendanceRecorder as unknown as { takeAfterStop(f: Att, i: Att, s: string): boolean }).takeAfterStop(from, into, iso(stop));

    assert.equal(moved, true);
    assert.deepEqual(from.samples.map((x) => x.t), [at(-20, 0).t, at(30, 0).t, at(72, 0).t], "its own ramp or its taper moved");
    assert.equal(into.attendanceBaseline, 400, "the incoming record's own baseline was replaced");
    assert.deepEqual(into.samples.map((x) => [x.t, x.attendance]), [[at(70, 0).t, 10], [at(74, 0).t, 30], [at(90, 0).t, 50]]);
  });

  it("still holds attendance on the ramp through a brief mode drop mid-overrun", async () => {
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 74 * MIN, rolling, "song");
    for (let at = NINE + 76 * MIN; at <= NINE + 80 * MIN; at += 2 * MIN) await tickNoItem(at, "occ-b");
    await tick(NINE + 82 * MIN, "occ-b", "response");

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-a"), `${name}: a lull mid-overrun split the record`);
      assert.equal(rec.current?.endedAt, null, `${name}: the record is open again`);
    }
  });

  it("takes attendance back to the service when the airing it stopped on returns after the ramp split", async (t) => {
    // Mid-overrun, Planning Center leaves item mode for twelve minutes inside
    // the 11am's arrival window, then comes back on the same airing. The item
    // recorders hold it for the 9am; attendance had split onto the 11am's ramp.
    const { sensourceService } = await import("./sensource-service.js");
    t.mock.method(sensourceService, "getLatest", () => ({ connected: true, total: { attendance: 1000, occupancy: 200 } }));
    await tick(NINE, "occ-a", "welcome");
    const songLive = NINE + 2 * MIN;
    await airs(songLive, NINE + 74 * MIN, rolling, "song");
    for (let at = NINE + 76 * MIN; at <= NINE + 88 * MIN; at += 2 * MIN) await tickNoItem(at, "occ-b");
    await tick(NINE + 90 * MIN, "occ-b", "song", { since: songLive });

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-a"), `${name}: the returning airing went to the next service`);
      assert.equal(rec.current?.endedAt, null, `${name}: the record is open again`);
    }
    // The lull's counts are the 9am's again, as the item recorders keep the lull.
    type Counts = { samples: { t: string; phase?: string }[] };
    const back = (await RECORDERS[1]![1].getRecord(keyFor("occ-b"))) as unknown as Counts | null;
    assert.deepEqual(back?.samples.filter((x) => x.phase === "pre").map((x) => x.t), [], "the lull's counts stayed with the 11am");
    const nineCounts = RECORDERS[1]![1].current as unknown as Counts;
    assert.ok(nineCounts.samples.some((x) => Date.parse(x.t) >= NINE + 76 * MIN && x.phase === "pre"), "the lull's counts are missing from the 9am");
    // The ramp record it left closes after it opened, not at the 9am's stop.
    const ramp = await RECORDERS[1]![1].getRecord(keyFor("occ-b"));
    const opened = (ramp as unknown as { startedAt: string } | null)?.startedAt;
    assert.ok(ramp?.endedAt && opened && ramp.endedAt >= opened, `the ramp record ends ${ramp?.endedAt} before it opens ${opened}`);
  });

  it("does not go back to a record deleted in History while it was being looked up", async (t) => {
    await tick(NINE, "occ-a", "welcome");
    const songLive = NINE + 2 * MIN;
    await airs(songLive, NINE + 74 * MIN, rolling, "song");
    for (let at = NINE + 76 * MIN; at <= NINE + 88 * MIN; at += 2 * MIN) await tickNoItem(at, "occ-b");
    const { attendanceStore } = await import("./attendance-store.js");
    const realGet = attendanceStore.get.bind(attendanceStore);
    let lookups = 0;
    t.mock.method(attendanceStore, "get", async (key: string) => {
      // The operator's delete lands during the first read, the go-back lookup.
      if (key === keyFor("occ-a") && lookups++ === 0) attendanceRecorder.forget(key);
      return realGet(key);
    });
    await tick(NINE + 90 * MIN, "occ-b", "song", { since: songLive });

    assert.notEqual(RECORDERS[1]![1].current?.serviceKey, keyFor("occ-a"), "went back to a record deleted in History");
  });

  it("does not make up the stopped service's record when it is gone by the time it is resumed", async (t) => {
    await tick(NINE, "occ-a", "welcome");
    const songLive = NINE + 2 * MIN;
    await airs(songLive, NINE + 74 * MIN, rolling, "song");
    for (let at = NINE + 76 * MIN; at <= NINE + 88 * MIN; at += 2 * MIN) await tickNoItem(at, "occ-b");
    const { attendanceStore } = await import("./attendance-store.js");
    const realGet = attendanceStore.get.bind(attendanceStore);
    let reads = 0;
    t.mock.method(attendanceStore, "get", async (key: string) => {
      // There for the go-back lookup, gone by the read that resumes it.
      if (key === keyFor("occ-a") && reads++ > 0) return null;
      return realGet(key);
    });
    await tick(NINE + 90 * MIN, "occ-b", "song", { since: songLive });

    const cur = RECORDERS[1]![1].current as unknown as { serviceKey: string; serviceTimeId: string | null } | null;
    assert.ok(!(cur?.serviceKey === keyFor("occ-a") && cur.serviceTimeId === "occ-b"), "made a 9am record carrying the 11am's occurrence");
  });

  it("splits with the item recorders when the airing that returns is the service's opening item", async () => {
    // The opener was on air when Planning Center dropped out, and the
    // occurrence rolled during the drop. The item recorders take the opener
    // going live in a hold as the next service starting.
    await airs(NINE, NINE + 58 * MIN, rolling, "welcome");
    for (let at = NINE + 60 * MIN; at <= NINE + 70 * MIN; at += 2 * MIN) await tickNoItem(at, "occ-b");
    await tick(NINE + 72 * MIN, "occ-b", "welcome", { since: NINE });

    const where = RECORDERS.map(([name, rec]) => `${name}=${rec.current?.serviceKey}`).join(" ");
    for (const [, rec] of RECORDERS) assert.equal(rec.current?.serviceKey, keyFor("occ-b"), where);
  });

  it("splits with the item recorders when the airing returns inside the next service's ten minutes", async () => {
    await tick(NINE, "occ-a", "welcome");
    const songLive = NINE + 2 * MIN;
    await airs(songLive, NINE + 74 * MIN, rolling, "song");
    for (let at = NINE + 76 * MIN; at <= NINE + 110 * MIN; at += 2 * MIN) await tickNoItem(at, "occ-b");
    await tick(NINE + 112 * MIN, "occ-b", "song", { since: songLive });

    const where = RECORDERS.map(([name, rec]) => `${name}=${rec.current?.serviceKey}`).join(" ");
    for (const [, rec] of RECORDERS) assert.equal(rec.current?.serviceKey, keyFor("occ-b"), where);
  });

  it("still resumes the closed record after a brief mode drop mid-service", async () => {
    // The 9am overran its planned end, so the live occurrence has rolled; a
    // mode drop closes the records and the operator comes back on the next item.
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 74 * MIN, rolling, "song");
    await airs(NINE + 75 * MIN, NINE + 77 * MIN, rolling, "message");
    await tickNoItem(NINE + 78 * MIN, "occ-b");
    await tick(NINE + 80 * MIN, "occ-b", "response");

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-a"), `${name}: a lull mid-service split the record`);
      assert.equal(rec.current?.endedAt, null, `${name}: the record is open again`);
    }
  });

  it("still resumes the closed record when the airing it closed on comes back", async () => {
    // Planning Center dropped out of item mode for a quarter of an hour, then
    // came back on the item that was on air: the same airing, the same service.
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 64 * MIN, rolling, "song");
    const messageLive = NINE + 65 * MIN;
    await airs(messageLive, NINE + 70 * MIN, rolling, "message");
    await tickNoItem(NINE + 71 * MIN, "occ-b");
    await tick(NINE + 86 * MIN, "occ-b", "message", { since: messageLive });

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-a"), `${name}: the airing the service closed on split it`);
      assert.equal(rec.current?.endedAt, null, `${name}: the record is open again`);
    }
  });
});

describe("silence is not an end", () => {
  let planId = "";
  let n = 0;
  const keyFor = (occ: string) => `75953:${planId}:${occ}`;

  beforeEach((t) => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    captureConsole(t as TestContext, "log", "warn", "error");
    planId = `silent-${++n}`;
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "Service",
      planId,
      planTitle: "Silent",
      planSeriesTitle: null,
    });
    for (const [, rec] of RECORDERS) {
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
      rec.stoppedAt = 0;
      rec.splitOnRamp = null;
      // A previous test's airing would count as already on air here.
      rec.lastAiring = null;
      rec.inheritedAiring = null;
    }
  });

  afterEach(() => {
    for (const [, rec] of RECORDERS) {
      for (const occ of ["occ-a", "occ-b"]) rec.forget(keyFor(occ));
      rec.current = null;
      rec.currentKey = null;
    }
    mock.timers.tick(61_000);
    mock.timers.reset();
  });

  it("holds the overrunning service through a Planning Center outage", async () => {
    // No ticks at all for a quarter of an hour, mid-overrun; the operator moved
    // on meanwhile. Nothing said the service stopped, so it has not.
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 64 * MIN, rolling, "song");
    await tick(NINE + 80 * MIN, "occ-b", "message");

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-a"), `${name}: an outage split the running service`);
      assert.equal(rec.current?.endedAt, null, `${name}: the record closed`);
    }
  });

  it("holds through the first tick after a restart, with nothing yet to say the service stopped", async () => {
    // As if a running record were resumed into memory at boot: the recorder
    // holds it, but has seen no tick of this process, running or stopped.
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 64 * MIN, rolling, "song");
    for (const [, rec] of RECORDERS) {
      rec.lastLiveAt = 0;
      rec.stoppedAt = 0;
      rec.splitOnRamp = null;
    }
    await tick(NINE + 66 * MIN, "occ-b", "message");

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-a"), `${name}: a restart split the running service`);
    }
  });

  it("holds through the first tick after a restart when the occurrence has no start time", async () => {
    await tick(NINE, "occ-a", "welcome");
    await airs(NINE + 2 * MIN, NINE + 64 * MIN, rolling, "song");
    for (const [, rec] of RECORDERS) {
      rec.lastLiveAt = 0;
      rec.stoppedAt = 0;
      rec.splitOnRamp = null;
    }
    START.delete("occ-b");
    try {
      await tick(NINE + 66 * MIN, "occ-b", "message");
    } finally {
      START.set("occ-b", ELEVEN);
    }

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-a"), `${name}: a restart split the running service`);
    }
  });
});
