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
  lastStoppedAt: number;
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
    serviceTimeStartsAt: iso(START.get(occ)!),
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
    serviceTimeStartsAt: iso(START.get(occ)!),
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
      rec.lastStoppedAt = 0;
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
      rec.lastStoppedAt = 0;
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
});
