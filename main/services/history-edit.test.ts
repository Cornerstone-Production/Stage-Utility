// Merging a mis-split service used to corrupt the record it was fixing.
//
// A service overruns, PCO rolls the service time, and the tail lands as a
// separate occurrence. The operator merges the tail into the original — the
// documented repair. But each record stores its samples as raw-minus-its-OWN
// baseline, so the tail's start near zero while the original's end near its full
// count. Concatenating them raw put a cliff to zero at the seam and pulled the
// service average and lastAttendance down with it.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ServiceAttendance } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-edit-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { attendanceStore } = await import("./attendance-store.js");
const { splHistoryStore } = await import("./spl-history-store.js");
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { deleteServiceRecords, editServiceWindow, mergeServiceRecords, recalcAttendance, ServiceIsLiveError } =
  await import("./history-edit.js");

const T0 = Date.parse("2026-08-09T14:00:00.000Z");

/** A record whose samples are already baselined against `baseline`. */
function record(key: string, baseline: number, raws: number[], startMin: number): ServiceAttendance {
  return {
    serviceKey: key,
    serviceTypeId: "st1",
    serviceTypeName: null,
    planId: "p1",
    planTitle: "Sunday",
    seriesTitle: null,
    serviceDate: "2026-08-09",
    serviceTimeId: key,
    serviceTimeStartsAt: new Date(T0).toISOString(),
    startedAt: new Date(T0 + startMin * 60_000).toISOString(),
    serviceStartedAt: new Date(T0 + startMin * 60_000).toISOString(),
    endedAt: new Date(T0 + (startMin + raws.length) * 60_000).toISOString(),
    samples: raws.map((raw, i) => ({
      t: new Date(T0 + (startMin + i) * 60_000).toISOString(),
      attendance: raw - baseline,
      occupancy: raw,
    })),
    attendanceBaseline: baseline,
    totalAttendance: raws[raws.length - 1] ?? 0,
    peakAttendance: Math.max(...raws.map((r) => r - baseline)),
    peakOccupancy: Math.max(...raws),
    minOccupancy: Math.min(...raws),
    lastAttendance: (raws[raws.length - 1] ?? 0) - baseline,
    lastOccupancy: raws[raws.length - 1] ?? 0,
  } as unknown as ServiceAttendance;
}

describe("merging a split attendance record", () => {
  it("does not put a cliff at the seam", async () => {
    // The 9am ran from a raw counter of 100 up to 550 — 450 people.
    const target = record("st-9", 100, [100, 300, 550], 0);
    // The tail was recorded separately, so it baselined itself at 550 and its own
    // samples read 0, 20, 30 — while representing 550, 570, 580 people in the room.
    const source = record("st-tail", 550, [550, 570, 580], 10);
    await attendanceStore.upsert(target);
    await attendanceStore.upsert(source);

    await mergeServiceRecords("st-tail", "st-9");

    const merged = await attendanceStore.get("st-9");
    assert.ok(merged, "target record missing after merge");
    const series = merged.samples.map((s) => s.attendance);

    // The curve must not fall back toward zero after the seam.
    for (let i = 1; i < series.length; i++) {
      assert.ok(
        series[i] >= series[i - 1] - 50,
        `cliff at index ${i}: ${series.join(", ")}`,
      );
    }
    // And the tail must read as the ~480 it actually was, not the 30 it stored.
    assert.ok(series.at(-1)! > 400, `tail collapsed to ${series.at(-1)} — series ${series.join(", ")}`);
  });

  it("carries the later end time onto the merged record", async () => {
    const merged = await attendanceStore.get("st-9");
    assert.ok(merged?.endedAt);
  });

  it("removes the source record", async () => {
    assert.equal(await attendanceStore.get("st-tail"), null);
  });
});

describe("merging in the other direction, and after a recalculate", () => {
  it("does not flatten a source that is EARLIER than the target", async () => {
    // The panel offers every same-day recording as a target, and merging a
    // spurious leading fragment INTO the main record is the natural repair. That
    // makes the offset negative; clamping it at zero deleted the fragment's
    // attendees outright.
    const fragment = record("frag", 100, [100, 120, 150], 0); // raw 100-150
    const main = record("main", 150, [150, 300, 550], 20); // raw 150-550
    await attendanceStore.upsert(fragment);
    await attendanceStore.upsert(main);

    await mergeServiceRecords("frag", "main");

    const merged = await attendanceStore.get("main");
    const series = merged!.samples.map((s) => s.attendance);
    assert.ok(series.some((v) => v > 0 && v < 60), `fragment flattened: ${series.join(", ")}`);
    assert.equal(series.at(-1), 450, `tail should be 550-100: ${series.join(", ")}`);
  });

  it("survives a record whose baseline was rewritten by a recalculate", async () => {
    // recomputeAttendance used to overwrite attendanceBaseline with an already
    // baselined value, so a later merge read it as raw and shifted by ~100 people.
    const target = record("t2", 100, [100, 300, 550], 0);
    await attendanceStore.upsert(target);
    await recalcAttendance("t2"); // rewrites the baseline

    const tail = record("tail2", 550, [550, 570, 580], 10);
    await attendanceStore.upsert(tail);
    await mergeServiceRecords("tail2", "t2");

    const series = (await attendanceStore.get("t2"))!.samples.map((s) => s.attendance);
    assert.equal(series.at(-1), 480, `expected 580-100=480, got ${series.join(", ")}`);
  });
});

// ── Deleting and re-windowing, against the real stores and real recorders ───
//
// Three more defects of the same family — an edit here, a recorder there, both
// holding the same record.
//
//   Deleting a service removed one of its three records. The attendance,
//   timeline and SPL stores each had their own DELETE route, and History called
//   exactly one; the two settings panels that called the others were removed as
//   unreachable, taking the last callers with them. The SPL and attendance
//   records stayed on disk, invisible and undeletable, and still counted by
//   every aggregate reading those stores.
//
//   Editing a window was undone. forget() was added to the delete and merge
//   paths when a record was found resurrecting itself; the edit paths were
//   missed, so a trim survived until the recorder's next debounce wrote the
//   untrimmed copy back.
//
//   Editing a LIVE service cannot be made safe by ordering. forget() releases
//   the recorder's copy, but the next tick re-establishes the same key and
//   starts a fresh empty record. So it is refused instead.

const LIVE_KEY = "st1:plan9:11am";
const LIVE_DATE = "2026-07-26";

/** The lifecycle fields the base class owns, reached directly: these cases are
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

/** Put every recorder mid-service on LIVE_KEY, the way a Sunday morning would. */
function goLive() {
  for (const [, r] of RECORDERS) {
    r.current = { serviceKey: LIVE_KEY, endedAt: null };
    r.currentKey = LIVE_KEY;
    r.lastLiveAt = Date.now();
  }
}

const identity = {
  serviceTypeId: "st1", planId: "plan9", planTitle: null, seriesTitle: null,
  serviceDate: LIVE_DATE, serviceTimeId: "11am", serviceTimeStartsAt: null,
  startedAt: "2026-07-26T11:00:00.000Z", endedAt: "2026-07-26T12:00:00.000Z",
};

async function seedAll(key = LIVE_KEY) {
  await serviceTimelineStore.upsert({ ...identity, serviceKey: key, items: [] } as never);
  await attendanceStore.upsert({
    ...identity, serviceKey: key,
    attendanceBaseline: 0, totalAttendance: 0, peakAttendance: 0, peakOccupancy: 0,
    minOccupancy: null, lastAttendance: 0, lastOccupancy: 0,
    samples: [
      { t: "2026-07-26T11:10:00.000Z", attendance: 100, occupancy: 100 },
      { t: "2026-07-26T12:30:00.000Z", attendance: 5, occupancy: 5 },
    ],
  } as never);
  await splHistoryStore.upsert({ ...identity, serviceKey: key, metricKey: null, items: [] } as never);
}

describe("deleteServiceRecords", () => {
  beforeEach(async () => {
    idle();
    await seedAll();
  });

  it("removes all three records, not just the one whose route was called", async () => {
    // THE regression. Before the fix History's delete removed the timeline and
    // left the SPL and attendance records behind for good.
    const result = await deleteServiceRecords(LIVE_KEY);

    assert.deepEqual(result.records.slice().sort(), ["attendance", "spl", "timeline"]);
    assert.equal(result.deleted, true);
    assert.equal(await serviceTimelineStore.get(LIVE_KEY), null, "timeline record still there");
    assert.equal(await attendanceStore.get(LIVE_KEY), null, "attendance record still there");
    assert.equal(await splHistoryStore.get(LIVE_KEY), null, "SPL record still there");
  });

  it("reports honestly when there was nothing to delete", async () => {
    await deleteServiceRecords(LIVE_KEY);
    assert.deepEqual(await deleteServiceRecords(LIVE_KEY), { deleted: false, records: [] });
  });

  it("releases every recorder, so the delete is not written back", async () => {
    for (const [, r] of RECORDERS) {
      r.current = { serviceKey: LIVE_KEY };
      r.currentKey = LIVE_KEY;
      r.dirty = true;
      r.persistTimer = setTimeout(() => {}, 60_000);
    }
    await deleteServiceRecords(LIVE_KEY);
    for (const [name, r] of RECORDERS) {
      assert.equal(r.current, null, `${name} still holds the deleted record`);
      assert.equal(r.persistTimer, null, `${name} still has a persist queued`);
    }
  });

  it("refuses while the service is recording", async () => {
    goLive();
    await assert.rejects(() => deleteServiceRecords(LIVE_KEY), ServiceIsLiveError);
    assert.notEqual(await serviceTimelineStore.get(LIVE_KEY), null, "nothing may be deleted on a refusal");
    assert.notEqual(await attendanceStore.get(LIVE_KEY), null);
    assert.notEqual(await splHistoryStore.get(LIVE_KEY), null);
  });

  it("allows the delete once the service has ended", async () => {
    goLive();
    // The recorder stamps endedAt when the service closes; that alone releases
    // the lock, without waiting out the ten-minute gap.
    for (const [, r] of RECORDERS) r.current!.endedAt = "2026-07-26T12:00:00.000Z";
    await deleteServiceRecords(LIVE_KEY);
    assert.equal(await serviceTimelineStore.get(LIVE_KEY), null);
  });

  it("does not lock a DIFFERENT service because this one is live", async () => {
    goLive();
    await seedAll("st1:plan9:9am");
    const r = await deleteServiceRecords("st1:plan9:9am");
    assert.equal(r.deleted, true, "the 9am must still be deletable while the 11am runs");
  });

  it("deletes an attendance-only record — the pre-service arrival ramp, before any timeline record exists", async () => {
    // The attendance recorder opens its record up to an hour before the first
    // PCO item goes live (main/services/attendance-recorder.ts) — History's
    // "arriving" row is exactly this case, with no timeline or SPL record yet.
    // "Delete recording" on that row must not assume all three stores are there.
    const key = "st1:plan9:arriving-only";
    await attendanceStore.upsert({
      ...identity, serviceKey: key,
      attendanceBaseline: 0, totalAttendance: 0, peakAttendance: 0, peakOccupancy: 0,
      minOccupancy: null, lastAttendance: 0, lastOccupancy: 0, samples: [],
    } as never);
    assert.equal(await serviceTimelineStore.get(key), null, "precondition: no timeline record");
    assert.equal(await splHistoryStore.get(key), null, "precondition: no SPL record");

    const result = await deleteServiceRecords(key);
    assert.deepEqual(result, { deleted: true, records: ["attendance"] });
    assert.equal(await attendanceStore.get(key), null, "attendance record still there");
  });
});

describe("editServiceWindow and recalcAttendance", () => {
  beforeEach(async () => {
    idle();
    await seedAll();
  });

  it("releases the recorder before writing, so the edit is not reverted", async () => {
    // Without forget(), this pending persist fires and writes the untrimmed
    // record straight back over the trimmed one.
    const att = attendanceRecorder as unknown as Held;
    att.current = { serviceKey: LIVE_KEY };
    att.currentKey = LIVE_KEY;
    att.dirty = true;
    att.persistTimer = setTimeout(() => {}, 60_000);

    await editServiceWindow(LIVE_KEY, { endedAt: "2026-07-26T12:00:00.000Z" });

    assert.equal(att.current, null, "the recorder still holds the pre-edit record");
    assert.equal(att.persistTimer, null, "a persist is still queued over the edit");
  });

  it("re-tags a sample past the new end rather than deleting it", async () => {
    // This asserted the sample was GONE, which was the data-loss bug: the 12:30
    // reading is the room emptying, half an hour into a 60-minute taper window,
    // and trimming the end to 12:00 is exactly when you want to keep looking at
    // it. It is kept and tagged `post`, which is what excludes it from
    // Peak/Lowest without excluding it from the curve.
    await editServiceWindow(LIVE_KEY, { endedAt: "2026-07-26T12:00:00.000Z" });
    const after = await attendanceStore.get(LIVE_KEY);
    assert.equal(after?.samples.length, 2, "a taper sample was deleted by a window edit");
    assert.equal(after?.samples.find((x) => x.t.startsWith("2026-07-26T12:30"))?.phase, "post");
  });

  it("still drops a sample beyond the taper window entirely", async () => {
    // Trimming a bad capture has to actually trim. 12:30 is 90 minutes past an
    // 11:00 end, well outside the 60-minute taper.
    await editServiceWindow(LIVE_KEY, { endedAt: "2026-07-26T11:00:00.000Z" });
    assert.equal((await attendanceStore.get(LIVE_KEY))?.samples.length, 1, "a sample past the taper survived");
  });

  it("refuses a window edit while the service is recording", async () => {
    goLive();
    await assert.rejects(
      () => editServiceWindow(LIVE_KEY, { endedAt: "2026-07-26T11:30:00.000Z" }),
      ServiceIsLiveError,
    );
    assert.equal((await attendanceStore.get(LIVE_KEY))?.samples.length, 2, "a refused edit changed data");
  });

  it("recalcAttendance releases the recorder too", async () => {
    const att = attendanceRecorder as unknown as Held;
    att.current = { serviceKey: LIVE_KEY };
    att.currentKey = LIVE_KEY;
    att.dirty = true;
    att.persistTimer = setTimeout(() => {}, 60_000);

    await recalcAttendance(LIVE_KEY);

    assert.equal(att.current, null);
    assert.equal(att.persistTimer, null);
  });

  it("refuses a recalculate while the service is recording", async () => {
    goLive();
    await assert.rejects(() => recalcAttendance(LIVE_KEY), ServiceIsLiveError);
  });
});

describe("mergeServiceRecords, live", () => {
  it("refuses when either side is recording", async () => {
    idle();
    await seedAll("merge-a");
    await seedAll("merge-b");
    const [, r] = RECORDERS[0];
    r.current = { serviceKey: "merge-b", endedAt: null };
    r.currentKey = "merge-b";
    r.lastLiveAt = Date.now();

    await assert.rejects(() => mergeServiceRecords("merge-a", "merge-b"), ServiceIsLiveError);
    await assert.rejects(() => mergeServiceRecords("merge-b", "merge-a"), ServiceIsLiveError);
    assert.notEqual(await attendanceStore.get("merge-a"), null, "a refused merge deleted the source");
    idle();
  });
});

describe("merging when only one side has a record in a store", () => {
  // The archive is moved FIRST and unconditionally, but each store used to merge
  // only `if (src && tgt)`. When the target had no record in a store — the
  // attendance sensor was offline for the main service but the fragment caught
  // samples, or SPL was recorded on one side only — that source record was
  // neither merged nor deleted, and its raw rows had already been moved out from
  // under it. The operator was told the merge succeeded, the fragment stayed in
  // the History list, and a rebuild of either record produced wrong numbers.
  beforeEach(async () => {
    for (const k of ["src", "tgt"]) {
      await attendanceStore.delete(k);
      await splHistoryStore.delete(k);
      await serviceTimelineStore.delete(k);
    }
  });

  it("re-keys a source-only record onto the target instead of orphaning it", async () => {
    // Target exists in attendance only; source exists in attendance AND spl.
    await attendanceStore.upsert(record("tgt", 100, [100, 110], 0));
    await attendanceStore.upsert(record("src", 200, [200, 210], 30));
    await splHistoryStore.upsert({
      serviceKey: "src",
      serviceTypeId: "st1", serviceTypeName: null, planId: "p1", planTitle: "Sunday",
      seriesTitle: null, serviceDate: "2026-08-09", serviceTimeId: "src",
      serviceTimeStartsAt: new Date(T0).toISOString(),
      startedAt: new Date(T0).toISOString(), endedAt: null,
      meterId: null, metricKey: null, items: [],
    } as never);

    const outcome = await mergeServiceRecords("src", "tgt");

    assert.deepEqual(outcome.merged, ["attendance"], "attendance had both sides");
    assert.deepEqual(outcome.moved, ["spl"], "spl had only the source and must be re-keyed");

    assert.equal(await splHistoryStore.get("src"), null, "the orphan must not be left behind");
    const spl = await splHistoryStore.get("tgt");
    assert.ok(spl, "the source's SPL data must survive under the target key");
    assert.equal(spl.serviceKey, "tgt", "and must be re-keyed, not just copied");
  });

  it("reports which stores it touched rather than a bare ok", async () => {
    await attendanceStore.upsert(record("tgt", 100, [100], 0));
    await attendanceStore.upsert(record("src", 200, [200], 30));

    const outcome = await mergeServiceRecords("src", "tgt");

    // Partial success used to be indistinguishable from complete success.
    assert.deepEqual(outcome.merged, ["attendance"]);
    assert.deepEqual(outcome.moved, []);
    assert.equal(typeof outcome.archivesMoved, "boolean");
  });

  it("refuses when the target has no record at all, before anything moves", async () => {
    await attendanceStore.upsert(record("src", 200, [200], 30));
    await assert.rejects(
      () => mergeServiceRecords("src", "tgt"),
      /Nothing to merge into/,
      "merging into nothing must fail loudly, not move an archive under a record that is not there",
    );
    assert.ok(await attendanceStore.get("src"), "the source must be untouched");
  });
});

describe("editing a service window keeps the ramp and the taper", () => {
  // The bug this exists for: `att.samples` was filtered to the service window
  // and then upserted, so the FIRST timing correction deleted every pre-service
  // and post-service sample from the stored record. The arrival ramp and the
  // emptying-room fade an operator was looking at vanished because they nudged
  // an end time by a minute — and the write is destructive, so they do not come
  // back.
  const KEY = "taper-key";

  /** A record with 10 in-service minutes, a 20-minute ramp before it and a
   *  20-minute taper after — the shape the recorder actually writes. */
  async function seed(): Promise<void> {
    const startMs = T0 + 30 * 60_000;
    const endMs = startMs + 10 * 60_000;
    const at = (ms: number, phase?: "pre" | "post") => ({
      t: new Date(ms).toISOString(),
      attendance: 10,
      occupancy: 10,
      ...(phase ? { phase } : {}),
    });
    await attendanceStore.upsert({
      serviceKey: KEY,
      serviceTypeId: "st1", serviceTypeName: null, planId: "p1", planTitle: "Sunday",
      seriesTitle: null, serviceDate: "2026-08-09", serviceTimeId: KEY,
      serviceTimeStartsAt: new Date(T0).toISOString(),
      startedAt: new Date(startMs).toISOString(),
      serviceStartedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      samples: [
        at(startMs - 20 * 60_000, "pre"),
        at(startMs - 10 * 60_000, "pre"),
        at(startMs + 2 * 60_000),
        at(startMs + 8 * 60_000),
        at(endMs + 5 * 60_000, "post"),
        at(endMs + 15 * 60_000, "post"),
      ],
      attendanceBaseline: 0, totalAttendance: 10,
      peakAttendance: 10, peakOccupancy: 10, minOccupancy: 10,
      lastAttendance: 10, lastOccupancy: 10,
    } as unknown as ServiceAttendance);
  }

  beforeEach(seed);

  it("keeps the post-service taper when the end time is corrected", async () => {
    const before = await attendanceStore.get(KEY);
    const startMs = Date.parse(before!.startedAt);
    // Nudge the end by one minute — the smallest correction there is.
    await editServiceWindow(KEY, { endedAt: new Date(startMs + 11 * 60_000).toISOString() });

    const after = await attendanceStore.get(KEY);
    const post = after!.samples.filter((s) => s.phase === "post");
    assert.ok(post.length > 0, "the taper was deleted by a one-minute timing fix");
  });

  it("keeps the pre-service ramp too", async () => {
    const before = await attendanceStore.get(KEY);
    await editServiceWindow(KEY, { startedAt: new Date(Date.parse(before!.startedAt) + 60_000).toISOString() });

    const after = await attendanceStore.get(KEY);
    assert.ok(after!.samples.some((s) => s.phase === "pre"), "the arrival ramp was deleted");
  });

  it("re-tags a sample the new window swallowed", async () => {
    // Pull the start EARLIER than the first ramp sample: what was "pre" is now
    // inside the service, so it must stop being tagged — otherwise it goes on
    // being excluded from Peak/Lowest for a service it is now part of.
    const before = await attendanceStore.get(KEY);
    const startMs = Date.parse(before!.startedAt);
    await editServiceWindow(KEY, { startedAt: new Date(startMs - 25 * 60_000).toISOString() });

    const after = await attendanceStore.get(KEY);
    const wasRamp = after!.samples.find((s) => Date.parse(s.t) === startMs - 20 * 60_000);
    assert.ok(wasRamp, "the sample went missing entirely");
    assert.equal(wasRamp!.phase, undefined, "a sample now inside the service is still tagged as ramp");
  });

  it("still drops what falls outside even the ramp and taper", async () => {
    // Trimming a bad capture has to actually trim. The default taper window is
    // 60 minutes either side, so move the end two hours earlier and the late
    // taper samples fall outside it.
    const before = await attendanceStore.get(KEY);
    const startMs = Date.parse(before!.startedAt);
    await editServiceWindow(KEY, { endedAt: new Date(startMs + 3 * 60_000).toISOString() });

    const after = await attendanceStore.get(KEY);
    assert.ok(
      after!.samples.every((s) => Date.parse(s.t) <= startMs + 3 * 60_000 + 61 * 60_000),
      "a sample well past the taper window survived a trim",
    );
  });
});
