// The three recorders agree on where one service ends and the next begins, even
// when Planning Center sat parked past SERVICE END in between.
//
// Each recorder measures the gap since the last live tick it counted, and when
// the next occurrence has no start time to compare, that gap alone decides
// whether the new occurrence is the same service (hold) or the next (split). SPL
// and the timeline stop counting at SERVICE END; attendance counted every tick on
// a live item, the parked taper ticks too. So after a service that sat parked,
// the next service's first item split the SPL and timeline records and HELD the
// attendance one: it reopened the finished service's attendance record and
// sampled the next service into it.
//
// Driven through the three real recorders' onLiveTick, in live-poller.ts order.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { PcoLiveDTO } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-parked-split-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { stageController } = await import("./stage-controller.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { captureConsole } = await import("./fixtures/capture-console.js");
const { addBroadcastListener } = await import("./broadcaster.js");
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { sampleArchive } = await import("./archive/sample-archive.js");

type Rec = { serviceKey: string; endedAt: string | null };
type Held = {
  current: Rec | null;
  currentKey: string | null;
  lastLiveAt: number;
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
const T0 = Date.parse("2026-11-08T15:00:00.000Z");

/** Planning Center out of item mode: the service is over. */
async function tickNoItem(atMs: number, occ: string) {
  mock.timers.setTime(atMs);
  const live: PcoLiveDTO = {
    mode: "none",
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
    serviceTimeStartsAt: null,
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
    serviceTimeStartsAt: null, // no start to compare: the gap decides
    serviceEnded: opts.serviceEnded ?? false,
    beforeServiceStart: false,
  };
  await splRecorder.onLiveTick(live);
  await attendanceRecorder.onLiveTick(live);
  await serviceTimelineRecorder.onLiveTick(live);
}

describe("a service parked past SERVICE END, then the next one", () => {
  let planId = "";
  let n = 0;
  const keyFor = (occ: string) => `75953:${planId}:${occ}`;

  beforeEach((t) => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    captureConsole(t as TestContext, "log", "warn", "error");
    planId = `plan-${++n}`;
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "Service",
      planId,
      planTitle: "Parked",
      planSeriesTitle: null,
    });
    for (const [, rec] of RECORDERS) {
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
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

  it("splits all three recorders onto the next occurrence", async () => {
    await tick(T0, "occ-a", "song");
    const end = T0 + 30 * MIN;
    await tick(end, "occ-a", "dismissal", { serviceEnded: true });
    // Parked through the taper, the last tick 5 minutes before the next service.
    for (const m of [5, 15, 25]) await tick(end + m * MIN, "occ-a", "dismissal", { since: end, serviceEnded: true });
    await tick(end + 30 * MIN, "occ-b", "welcome");

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-b"), `${name}: held the finished service open for the next one`);
      const first = await rec.getRecord(keyFor("occ-a"));
      assert.equal(first?.endedAt, iso(end), `${name}: the finished service was reopened`);
    }
  });
});

// The live close (Planning Center leaving the service) closes every entry of the
// item-shaped records, and the timeline's with a length. That is the same item
// close the boot-time close uses; until this file nothing exercised it on the
// live path, so deleting it left the suite green.
describe("leaving the service", () => {
  let planId = "";
  let n = 0;
  const keyFor = (occ: string) => `75953:${planId}:${occ}`;
  type Items = { items: { itemId: string; endedAt: string | null; actualDurationSec?: number | null }[] };

  beforeEach((t) => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    captureConsole(t as TestContext, "log", "warn", "error");
    planId = `close-${++n}`;
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "Service",
      planId,
      planTitle: "Close",
      planSeriesTitle: null,
    });
    for (const [, rec] of RECORDERS) {
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
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

  it("closes every item, and gives the timeline's last one its length", async () => {
    await tick(T0, "occ-a", "song");
    await tick(T0 + 10 * MIN, "occ-a", "message");
    await tickNoItem(T0 + 25 * MIN, "occ-a");

    for (const [name, rec] of [RECORDERS[0]!, RECORDERS[2]!]) {
      const record = rec.current as unknown as (Rec & Items) | null;
      assert.equal(record?.endedAt, iso(T0 + 25 * MIN), `${name}: the record closed`);
      const open = record?.items.filter((it) => it.endedAt == null).map((it) => it.itemId);
      assert.deepEqual(open, [], `${name}: a closed record still holds items with no end`);
    }
    const timeline = serviceTimelineRecorder.getCurrent();
    assert.equal(timeline?.items.find((it) => it.itemId === "message")?.actualDurationSec, 15 * 60);
  });

  it("resumes the closed record when an item comes back under a rolled occurrence", async () => {
    // A mode drop mid-service closes all three records; the item coming back
    // under a rolled-over occurrence id (a cache miss) is the same service, and
    // is held onto the record it closed rather than split into a new one.
    await tick(T0, "occ-a", "song");
    await tickNoItem(T0 + 5 * MIN, "occ-a");
    await tick(T0 + 7 * MIN, "occ-b", "song", { since: T0 });

    for (const [name, rec] of RECORDERS) {
      assert.equal(rec.current?.serviceKey, keyFor("occ-a"), `${name}: split a resumed service into a new record`);
      assert.equal(rec.current?.endedAt, null, `${name}: the record is open again`);
    }
  });

  it("names and releases SPL's raw-archive files once, on the close", async (t) => {
    await tick(T0, "occ-a", "song");
    const manifests = t.mock.method(sampleArchive, "writeManifest", async () => {});
    const released = t.mock.method(sampleArchive, "closeService", async () => {});
    await tickNoItem(T0 + 25 * MIN, "occ-a");
    await new Promise((r) => setImmediate(r)); // closeService follows writeManifest's promise

    // Only this test's service counts. An earlier test's close (its record was
    // closed by a mode drop) chains a real manifest write before closeService,
    // and under load that write can finish after this test has mocked both, so
    // its key lands in these calls. Each test has its own plan id.
    const mine = (key: string) => key.startsWith(`75953:${planId}:`);
    assert.deepEqual(manifests.mock.calls.map((c) => (c.arguments[0] as { serviceKey: string }).serviceKey).filter(mine), [keyFor("occ-a")]);
    assert.deepEqual(released.mock.calls.map((c) => c.arguments[0] as string).filter(mine), [keyFor("occ-a")]);
  });

  it("does not publish a record deleted in History while its close was saving", async (t) => {
    await tick(T0, "occ-a", "song");
    // The broadcaster has no unsubscribe; the listener stops collecting instead.
    const pushes: Rec[] = [];
    let collecting = true;
    addBroadcastListener((channel, payload) => {
      if (collecting && channel === "service-timeline:history") pushes.push(payload as Rec);
    });
    t.after(() => {
      collecting = false;
    });
    const realUpsert = serviceTimelineStore.upsert.bind(serviceTimelineStore);
    t.mock.method(serviceTimelineStore, "upsert", async (rec: Parameters<typeof realUpsert>[0]) => {
      serviceTimelineRecorder.forget(keyFor("occ-a")); // the operator's delete lands mid-save
      await realUpsert(rec);
    });
    await tickNoItem(T0 + 25 * MIN, "occ-a");

    assert.deepEqual(
      pushes.filter((p) => p?.serviceKey === keyFor("occ-a")),
      [],
      "a deleted record was pushed to the History page as closed",
    );
  });
});
