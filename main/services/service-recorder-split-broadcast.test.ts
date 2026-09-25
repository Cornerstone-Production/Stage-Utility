// A split must tell a History page the CLOSED record closed, not just open the
// new one.
//
// The incident (24 Sep 2026, v1.23.0, two services on one plan): at 8:05pm the
// recorders split correctly — the first service's timeline, attendance and SPL
// records all got endedAt and were saved — but a History page open at that
// moment kept showing the 8:00 row "recording" with a running time until it was
// reloaded. ensureRecord's split path (main/services/service-recorder.ts, "Key
// changed → finalize + persist the outgoing record") finalizes and persists the
// OUTGOING record and then builds the new one; only the new record's first push
// ever reached a client, because nothing broadcast the outgoing one.
//
// Driven through the three real recorders' onLiveTick, in the order
// live-poller.ts calls them, with the real broadcaster — see
// service-recorder-opening-item.test.ts, which established this pattern for the
// same shared base.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-split-broadcast-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { setAppTimeZone } = await import("./app-timezone.js");
setAppTimeZone("America/Chicago");

const { stageController } = await import("./stage-controller.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { addBroadcastListener } = await import("./broadcaster.js");

const OCC_1 = "occ-a";
const OCC_2 = "occ-b";

type Rec = { serviceKey: string; endedAt: string | null };
type Held = {
  current: Rec | null;
  currentKey: string | null;
  lastLiveAt: number;
  loggedServiceTimeChange: string | null;
  forget(key: string): boolean;
  getCurrent(): Rec | null;
};

const RECORDERS: { name: string; channel: string; rec: Held }[] = [
  { name: "spl-recorder", channel: "spl:history", rec: splRecorder as unknown as Held },
  { name: "attendance-recorder", channel: "attendance:history", rec: attendanceRecorder as unknown as Held },
  { name: "service-timeline-recorder", channel: "service-timeline:history", rec: serviceTimelineRecorder as unknown as Held },
];

/** Every push seen, in the order the recorders produced it. */
let pushes: { channel: string; payload: Rec }[] = [];
addBroadcastListener((channel, payload) => {
  pushes.push({ channel, payload: payload as Rec });
});

/** One live tick, at `at` (ISO), on `occ`, fed to all three recorders in the
 *  same order live-poller.ts uses (spl, attendance, timeline). */
function tick(
  at: string,
  occ: { id: string | null; startsAt: string | null },
  item: { id: string; title: string },
): Promise<unknown> {
  mock.timers.setTime(Date.parse(at));
  const live = {
    mode: "item" as const,
    currentItemId: item.id,
    label: item.title,
    itemType: null,
    lengthSec: null,
    liveStartAt: at,
    targetAt: null,
    serverNow: at,
    currentItemTitle: item.title,
    nextItemTitle: null,
    serviceTimeId: occ.id,
    serviceTimeStartsAt: occ.startsAt,
    beforeServiceStart: false,
  };
  return Promise.all([
    splRecorder.onLiveTick(live),
    attendanceRecorder.onLiveTick(live),
    serviceTimelineRecorder.onLiveTick(live),
  ]);
}

describe("a split broadcasts the record it closes", () => {
  let planId = "";
  let n = 0;

  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"] });
    planId = `plan-${++n}`;
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "The Salt Company",
      planId,
      planTitle: "Split Broadcast",
      planSeriesTitle: null,
    });
    for (const { rec } of RECORDERS) {
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
      rec.loggedServiceTimeChange = null;
    }
    pushes = [];
  });

  afterEach(() => {
    for (const { rec } of RECORDERS) {
      rec.forget(rec.currentKey ?? "");
      rec.current = null;
      rec.currentKey = null;
    }
    mock.timers.reset();
  });

  it("pushes the outgoing record closed, before the incoming record's own push", async () => {
    const occ1 = { id: OCC_1, startsAt: null };
    const occ2 = { id: OCC_2, startsAt: null };

    // Establish record 1, then jump the tick gap past SERVICE_GAP_MS on a new
    // occurrence with no start time to compare against — an unconditional split
    // (see "splits on a start-less occurrence..." in service-recorder.test.ts).
    await tick("2026-09-24T20:00:00.000Z", occ1, { id: "doors", title: "Doors" });
    await tick("2026-09-24T22:05:00.000Z", occ2, { id: "welcome", title: "Welcome" });

    const key1 = `75953:${planId}:${OCC_1}`;
    const key2 = `75953:${planId}:${OCC_2}`;

    for (const { name, channel, rec } of RECORDERS) {
      assert.equal(rec.getCurrent()?.serviceKey, key2, `${name}: did not split onto the second occurrence`);

      // The first push for key1 is from the earlier tick establishing it, still
      // open — find the one carrying endedAt, which only the split can produce.
      const onChannel = pushes.filter((p) => p.channel === channel);
      const closedIdx = onChannel.findIndex((p) => p.payload.serviceKey === key1 && p.payload.endedAt);
      assert.notEqual(closedIdx, -1, `${name}: never broadcast ${key1} closed (endedAt set) on ${channel}`);

      // Attendance never reaches its own end-of-tick broadcast with SenSource
      // disconnected (the default in this test), so it may push no "new record"
      // message at all — only the timeline and SPL recorders' incoming pushes are
      // guaranteed within the same tick. Where a key2 push exists, it must come
      // after the close, never before it.
      const newIdx = onChannel.findIndex((p) => p.payload.serviceKey === key2);
      if (newIdx !== -1) {
        assert.ok(
          newIdx > closedIdx,
          `${name}: the new record's push (index ${newIdx}) came before or with the close (index ${closedIdx})`,
        );
      }
    }
  });
});
