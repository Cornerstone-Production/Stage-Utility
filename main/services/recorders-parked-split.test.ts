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
