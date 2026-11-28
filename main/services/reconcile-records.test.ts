// A record left open by a crash is closed at boot the way the recorders close one.
//
// The server dies mid-service and comes back after it. Nothing will ever close
// the records it was writing, so reconcileOpenRecords does it at boot. It had its
// own close, and it was not the recorders':
//
//   - SPL: the record got an end and its items did not, so a closed record held
//     items still "running".
//   - Timeline: the items got an end and no length, and nothing computes one on
//     read, so History's Actual total, the row and the overrun stats all skipped
//     the item.
//
// The length needs a clock that saw the item run. The timeline's own stamps stop
// at the last item change, and the recorder stamps that change from this host's
// clock AFTER Planning Center's live_start_at for the incoming item, so its
// "latest stamp" is a second or two past the last item's start: a length computed
// from it reads as an item that ran for two seconds. The one clock that keeps
// ticking through an item is the attendance recorder's in-service samples, every
// 30 s, so a record is measured when the same occurrence's attendance saw past the
// last item change, and keeps no length when it did not.
//
// Driven through the real stores and the real reconcileOpenRecords; the reopen
// case through the real recorders' onLiveTick.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  PcoLiveDTO,
  ServiceAttendance,
  ServiceSplHistory,
  ServiceTimeline,
} from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-reconcile-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { reconcileOpenRecords } = await import("./reconcile-records.js");
const { attendanceStore } = await import("./attendance-store.js");
const { splHistoryStore } = await import("./spl-history-store.js");
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { stageController } = await import("./stage-controller.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

const MIN = 60_000;
const HOUR_MS = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-11-08T15:00:00.000Z");
/** The trailing item, MESSAGE, went live in Planning Center at this instant... */
const MESSAGE_LIVE = T0 + 20 * MIN;
/** ...and the recorder saw it on its next tick, closing SONG from its own clock. */
const SONG_CLOSED = MESSAGE_LIVE + 2_000;
/** The server died here, mid-MESSAGE. */
const CRASH = T0 + 50 * MIN;

let planN = 0;
function identity(): { serviceKey: string; planId: string } {
  const planId = `plan-${++planN}`;
  return { serviceKey: `75953:${planId}:occ-a`, planId };
}

function base(id: { serviceKey: string; planId: string }) {
  return {
    serviceKey: id.serviceKey,
    serviceTypeId: "75953",
    serviceTypeName: "Service",
    planId: id.planId,
    planTitle: "Crash",
    seriesTitle: null,
    serviceDate: "2026-11-08",
    serviceTimeId: "occ-a",
    serviceTimeStartsAt: iso(T0),
    startedAt: iso(T0),
    endedAt: null,
  };
}

function openTimeline(id: { serviceKey: string; planId: string }): ServiceTimeline {
  return {
    ...base(id),
    items: [
      { itemId: "song", title: "Song", sequence: 0, plannedLengthSec: 1200, startedAt: iso(T0), endedAt: iso(SONG_CLOSED), actualDurationSec: 1202 },
      { itemId: "message", title: "Message", sequence: 1, plannedLengthSec: 1800, startedAt: iso(MESSAGE_LIVE), endedAt: null, actualDurationSec: null },
    ],
  };
}

function openSpl(id: { serviceKey: string; planId: string }): ServiceSplHistory {
  const item = (itemId: string, sequence: number, startedAt: number, endedAt: number | null) => ({
    itemId, title: itemId, itemType: null, sequence, metrics: {}, maxSpl: null, sampleCount: 0,
    startedAt: iso(startedAt), endedAt: endedAt == null ? null : iso(endedAt),
  });
  return { ...base(id), meterId: null, metricKey: null, items: [item("song", 0, T0, SONG_CLOSED), item("message", 1, MESSAGE_LIVE, null)] };
}

function openAttendance(id: { serviceKey: string; planId: string }, lastInServiceAt: number): ServiceAttendance {
  const samples = [{ t: iso(T0 - 20 * MIN), attendance: 10, occupancy: 10, phase: "pre" as const }];
  for (let at = T0; at <= lastInServiceAt; at += 5 * MIN) samples.push({ t: iso(at), attendance: 200, occupancy: 180 } as never);
  return {
    ...base(id),
    serviceStartedAt: iso(T0),
    samples,
    attendanceBaseline: 0,
    totalAttendance: 200,
    peakAttendance: 200,
    peakOccupancy: 180,
    minOccupancy: 180,
    lastAttendance: 200,
    lastOccupancy: 180,
  };
}

describe("closing a crashed service's records at boot", () => {
  beforeEach((t) => captureConsole(t as TestContext, "log", "warn", "error"));

  it("closes an SPL record's items, not only the record", async () => {
    const id = identity();
    await splHistoryStore.upsert(openSpl(id));
    await reconcileOpenRecords();

    const spl = await splHistoryStore.get(id.serviceKey);
    assert.ok(spl?.endedAt, "the record is closed");
    const open = spl.items.filter((it) => it.endedAt == null).map((it) => it.itemId);
    assert.deepEqual(open, [], "a closed SPL record still holds items with no end");
  });

  it("measures the last item when the occurrence's attendance saw it run", async () => {
    const id = identity();
    await serviceTimelineStore.upsert(openTimeline(id));
    await splHistoryStore.upsert(openSpl(id));
    await attendanceStore.upsert(openAttendance(id, CRASH));
    await reconcileOpenRecords();

    const tl = await serviceTimelineStore.get(id.serviceKey);
    const spl = await splHistoryStore.get(id.serviceKey);
    const att = await attendanceStore.get(id.serviceKey);
    const message = tl?.items.find((it) => it.itemId === "message");
    assert.equal(message?.endedAt, iso(CRASH), "closed at the last in-service people count");
    assert.equal(message?.actualDurationSec, (CRASH - MESSAGE_LIVE) / 1000, "the closed item has its length");
    // One occurrence, one end: History draws the service window from these.
    assert.deepEqual([tl?.endedAt, spl?.endedAt, att?.endedAt], [iso(CRASH), iso(CRASH), iso(CRASH)]);
    assert.equal(spl?.items.find((it) => it.itemId === "message")?.endedAt, iso(CRASH));
  });

  it("leaves the last item's length unknown when no clock saw past its start", async () => {
    // No attendance for this occurrence: the timeline's own latest stamp is
    // SONG's close, two seconds into MESSAGE. A length from that is a lie the
    // overrun stats would count as a 28-minute underrun.
    const id = identity();
    await serviceTimelineStore.upsert(openTimeline(id));
    await reconcileOpenRecords();

    const tl = await serviceTimelineStore.get(id.serviceKey);
    const message = tl?.items.find((it) => it.itemId === "message");
    assert.equal(tl?.endedAt, iso(SONG_CLOSED));
    assert.equal(message?.endedAt, iso(SONG_CLOSED), "closed, so it no longer reads as running");
    assert.equal(message?.actualDurationSec, null, "a length nothing measured");
    assert.equal(tl?.items[0]?.actualDurationSec, 1202, "a closed item is left as it was");
  });

  it("does not take the taper, or the arrival ramp, as the service running", async () => {
    const id = identity();
    await serviceTimelineStore.upsert(openTimeline(id));
    const att = openAttendance(id, MESSAGE_LIVE - 5 * MIN);
    att.samples.push({ t: iso(CRASH), attendance: 40, occupancy: 30, phase: "post" });
    att.endedAt = iso(MESSAGE_LIVE);
    await attendanceStore.upsert(att);
    await reconcileOpenRecords();

    const message = (await serviceTimelineStore.get(id.serviceKey))?.items.find((it) => it.itemId === "message");
    assert.equal(message?.endedAt, iso(SONG_CLOSED));
    assert.equal(message?.actualDurationSec, null);
  });
});

describe("what counts as the service running", () => {
  beforeEach((t) => captureConsole(t as TestContext, "log", "warn", "error"));

  it("measures a pre-roll item above SERVICE START that attendance saw run", async () => {
    // Attendance tags its samples "pre" on an item above SERVICE START as well
    // as on the arrival ramp; the timeline records that item like any other.
    const id = identity();
    await serviceTimelineStore.upsert(openTimeline(id));
    const att = openAttendance(id, MESSAGE_LIVE - 5 * MIN);
    att.samples.push({ t: iso(CRASH), attendance: 150, occupancy: 140, phase: "pre" });
    await attendanceStore.upsert(att);
    await reconcileOpenRecords();

    const message = (await serviceTimelineStore.get(id.serviceKey))?.items.find((it) => it.itemId === "message");
    assert.equal(message?.endedAt, iso(CRASH));
    assert.equal(message?.actualDurationSec, (CRASH - MESSAGE_LIVE) / 1000);
  });

  it("is not stopped by a stored attendance record with no samples", async () => {
    // Every attendance record is read for the witness, closed ones too, and an
    // imported or hand-edited one need not carry samples.
    const broken = identity();
    const att = openAttendance(broken, T0) as Partial<ServiceAttendance>;
    delete att.samples;
    att.endedAt = iso(T0 + HOUR_MS);
    await attendanceStore.upsert(att as ServiceAttendance);
    const id = identity();
    await serviceTimelineStore.upsert(openTimeline(id));
    await reconcileOpenRecords();

    assert.equal((await serviceTimelineStore.get(id.serviceKey))?.endedAt, iso(SONG_CLOSED), "the orphan was closed");
  });
});

describe("a service still live after the boot-time close", () => {
  let id = identity();

  beforeEach((t) => {
    captureConsole(t as TestContext, "log", "warn", "error");
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    id = identity();
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "Service",
      planId: id.planId,
      planTitle: "Crash",
      planSeriesTitle: null,
    });
  });

  afterEach(() => {
    for (const rec of [serviceTimelineRecorder, splRecorder]) rec.forget(id.serviceKey);
    mock.timers.tick(61_000);
    mock.timers.reset();
  });

  it("reopens the item that was on air, with no length, on the first live tick", async () => {
    await serviceTimelineStore.upsert(openTimeline(id));
    await splHistoryStore.upsert(openSpl(id));
    await attendanceStore.upsert(openAttendance(id, CRASH));
    await reconcileOpenRecords();

    const now = CRASH + 5 * MIN;
    mock.timers.setTime(now);
    const live: PcoLiveDTO = {
      mode: "item",
      currentItemId: "message",
      label: "Message",
      itemType: "item",
      lengthSec: 1800,
      liveStartAt: iso(MESSAGE_LIVE),
      targetAt: null,
      serverNow: iso(now),
      currentItemTitle: "Message",
      nextItemTitle: null,
      serviceTimeId: "occ-a",
      serviceTimeStartsAt: iso(T0),
      serviceEnded: false,
      beforeServiceStart: false,
    };
    await splRecorder.onLiveTick(live);
    await serviceTimelineRecorder.onLiveTick(live);

    const tl = serviceTimelineRecorder.getCurrent();
    const message = tl?.items.filter((it) => it.itemId === "message") ?? [];
    assert.equal(tl?.endedAt, null, "the record is open again");
    assert.equal(message.length, 1, "the same run, not a second entry");
    assert.equal(message[0]?.endedAt, null);
    assert.equal(message[0]?.actualDurationSec, null);
    const splMessage = splRecorder.getCurrent()?.items.filter((it) => it.itemId === "message") ?? [];
    assert.equal(splMessage.length, 1);
    assert.equal(splMessage[0]?.endedAt, null);
  });
});
