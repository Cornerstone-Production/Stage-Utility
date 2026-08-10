// Editing a recording, against the real stores and the real recorders.
//
// Three defects this covers, all of the same family — an edit here and a
// recorder there, both holding the same record:
//
//   Deleting a service removed one of its three records. The attendance,
//   timeline and SPL stores each had their own DELETE route, and History called
//   exactly one; the two settings panels that called the others were removed as
//   unreachable, taking the last callers with them. The SPL and attendance
//   records stayed on disk, invisible and undeletable, and still counted by
//   every aggregate that reads those stores.
//
//   Editing a service window was undone. The delete and merge paths were given
//   forget() when a record was found resurrecting itself; editServiceWindow,
//   recalcAttendance and setItemCounted were missed, so a trimmed window
//   survived until the recorder's next debounce wrote the untrimmed copy back.
//
//   Editing a LIVE service could not be made safe by ordering. forget() releases
//   the recorder's copy, but the next tick re-establishes the same key and
//   starts a fresh empty record — a delete that appeared to work and came back.
//   So it is refused instead.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-histedit-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { attendanceStore } = await import("./attendance-store.js");
const { splHistoryStore } = await import("./spl-history-store.js");
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { deleteServiceRecords, editServiceWindow, recalcAttendance, ServiceIsLiveError } =
  await import("./history-edit.js");

const KEY = "st1:plan9:11am";
const DATE = "2026-07-26";

/** The lifecycle fields the base class owns, reached directly: these tests are
 *  about what an edit does to a recorder that is mid-service, and driving a real
 *  PCO tick to get there would test the poller, not this. */
type Held = {
  current: Record<string, unknown> | null;
  currentKey: string | null;
  lastLiveAt: number;
  persistTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
};
const RECORDERS: [string, Held][] = [
  ["attendance", attendanceRecorder as unknown as Held],
  ["spl", splRecorder as unknown as Held],
  ["timeline", serviceTimelineRecorder as unknown as Held],
];

function idle() {
  for (const [, r] of RECORDERS) {
    if (r.persistTimer) clearTimeout(r.persistTimer);
    r.current = null;
    r.currentKey = null;
    r.lastLiveAt = 0;
    r.persistTimer = null;
    r.dirty = false;
  }
}

/** Put every recorder mid-service on KEY, the way a Sunday morning would. */
function goLive() {
  for (const [, r] of RECORDERS) {
    r.current = { serviceKey: KEY, endedAt: null };
    r.currentKey = KEY;
    r.lastLiveAt = Date.now();
  }
}

async function seedAll() {
  await serviceTimelineStore.upsert({
    serviceKey: KEY, serviceTypeId: "st1", planId: "plan9", planTitle: null, seriesTitle: null,
    serviceDate: DATE, serviceTimeId: "11am", serviceTimeStartsAt: null,
    startedAt: "2026-07-26T11:00:00.000Z", endedAt: "2026-07-26T12:00:00.000Z", items: [],
  } as never);
  await attendanceStore.upsert({
    serviceKey: KEY, serviceTypeId: "st1", planId: "plan9", planTitle: null, seriesTitle: null,
    serviceDate: DATE, serviceTimeId: "11am", serviceTimeStartsAt: null,
    startedAt: "2026-07-26T11:00:00.000Z", endedAt: "2026-07-26T12:00:00.000Z",
    attendanceBaseline: 0, totalAttendance: 0, peakAttendance: 0, peakOccupancy: 0,
    minOccupancy: null, lastAttendance: 0, lastOccupancy: 0,
    samples: [
      { t: "2026-07-26T11:10:00.000Z", attendance: 100, occupancy: 100 },
      { t: "2026-07-26T12:30:00.000Z", attendance: 5, occupancy: 5 },
    ],
  } as never);
  await splHistoryStore.upsert({
    serviceKey: KEY, serviceTypeId: "st1", planId: "plan9", planTitle: null, seriesTitle: null,
    serviceDate: DATE, serviceTimeId: "11am", serviceTimeStartsAt: null,
    startedAt: "2026-07-26T11:00:00.000Z", endedAt: "2026-07-26T12:00:00.000Z",
    metricKey: null, items: [],
  } as never);
}

describe("deleteServiceRecords", () => {
  beforeEach(async () => {
    idle();
    await seedAll();
  });

  it("removes all three records, not just the one whose route was called", async () => {
    // THE regression. Before the fix History's delete removed the timeline and
    // left the SPL and attendance records behind for good.
    const result = await deleteServiceRecords(KEY);

    assert.deepEqual(result.records.sort(), ["attendance", "spl", "timeline"]);
    assert.equal(result.deleted, true);
    assert.equal(await serviceTimelineStore.get(KEY), null, "timeline record still there");
    assert.equal(await attendanceStore.get(KEY), null, "attendance record still there");
    assert.equal(await splHistoryStore.get(KEY), null, "SPL record still there");
  });

  it("reports honestly when there was nothing to delete", async () => {
    await deleteServiceRecords(KEY);
    const again = await deleteServiceRecords(KEY);
    assert.deepEqual(again, { deleted: false, records: [] });
  });

  it("releases every recorder, so the delete is not written back", async () => {
    for (const [, r] of RECORDERS) {
      r.current = { serviceKey: KEY };
      r.currentKey = KEY;
      r.dirty = true;
      r.persistTimer = setTimeout(() => {}, 60_000);
    }
    await deleteServiceRecords(KEY);
    for (const [name, r] of RECORDERS) {
      assert.equal(r.current, null, `${name} still holds the deleted record`);
      assert.equal(r.persistTimer, null, `${name} still has a persist queued`);
    }
  });

  it("refuses while the service is recording", async () => {
    goLive();
    await assert.rejects(() => deleteServiceRecords(KEY), ServiceIsLiveError);
    assert.notEqual(await serviceTimelineStore.get(KEY), null, "nothing may be deleted on a refusal");
    assert.notEqual(await attendanceStore.get(KEY), null);
    assert.notEqual(await splHistoryStore.get(KEY), null);
  });

  it("allows the delete once the service has ended", async () => {
    goLive();
    // The recorder stamps endedAt when the service closes; that alone releases
    // the lock, without waiting out the ten-minute gap.
    for (const [, r] of RECORDERS) r.current!.endedAt = "2026-07-26T12:00:00.000Z";
    await deleteServiceRecords(KEY);
    assert.equal(await serviceTimelineStore.get(KEY), null);
  });

  it("does not lock a DIFFERENT service because this one is live", async () => {
    goLive();
    await serviceTimelineStore.upsert({
      serviceKey: "st1:plan9:9am", serviceTypeId: "st1", planId: "plan9", planTitle: null,
      seriesTitle: null, serviceDate: DATE, serviceTimeId: "9am", serviceTimeStartsAt: null,
      startedAt: "2026-07-26T09:00:00.000Z", endedAt: "2026-07-26T10:00:00.000Z", items: [],
    } as never);
    const r = await deleteServiceRecords("st1:plan9:9am");
    assert.equal(r.deleted, true, "the 9am must still be deletable while the 11am runs");
  });
});

describe("editServiceWindow", () => {
  beforeEach(async () => {
    idle();
    await seedAll();
  });

  it("releases the recorder before writing, so the edit is not reverted", async () => {
    // Without forget(), this pending persist fires and writes the untrimmed
    // record straight back over the trimmed one.
    const att = attendanceRecorder as unknown as Held;
    att.current = { serviceKey: KEY };
    att.currentKey = KEY;
    att.dirty = true;
    att.persistTimer = setTimeout(() => {}, 60_000);

    await editServiceWindow(KEY, { endedAt: "2026-07-26T12:00:00.000Z" });

    assert.equal(att.current, null, "the recorder still holds the pre-edit record");
    assert.equal(att.persistTimer, null, "a persist is still queued over the edit");
  });

  it("actually trims the samples outside the window", async () => {
    await editServiceWindow(KEY, { endedAt: "2026-07-26T12:00:00.000Z" });
    const after = await attendanceStore.get(KEY);
    assert.equal(after?.samples.length, 1, "the 12:30 sample is outside the window");
  });

  it("refuses while the service is recording", async () => {
    goLive();
    await assert.rejects(
      () => editServiceWindow(KEY, { endedAt: "2026-07-26T11:30:00.000Z" }),
      ServiceIsLiveError,
    );
    const after = await attendanceStore.get(KEY);
    assert.equal(after?.samples.length, 2, "a refused edit must change nothing");
  });
});

describe("recalcAttendance", () => {
  beforeEach(async () => {
    idle();
    await seedAll();
  });

  it("releases the recorder before writing", async () => {
    const att = attendanceRecorder as unknown as Held;
    att.current = { serviceKey: KEY };
    att.currentKey = KEY;
    att.dirty = true;
    att.persistTimer = setTimeout(() => {}, 60_000);

    await recalcAttendance(KEY);

    assert.equal(att.current, null);
    assert.equal(att.persistTimer, null);
  });

  it("refuses while the service is recording", async () => {
    goLive();
    await assert.rejects(() => recalcAttendance(KEY), ServiceIsLiveError);
  });
});
