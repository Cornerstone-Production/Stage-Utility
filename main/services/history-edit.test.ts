// Merging a mis-split service used to corrupt the record it was fixing.
//
// A service overruns, PCO rolls the service time, and the tail lands as a
// separate occurrence. The operator merges the tail into the original — the
// documented repair. But each record stores its samples as raw-minus-its-OWN
// baseline, so the tail's start near zero while the original's end near its full
// count. Concatenating them raw put a cliff to zero at the seam and pulled the
// service average and lastAttendance down with it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ServiceAttendance } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-edit-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { attendanceStore } = await import("./attendance-store.js");
const { mergeServiceRecords } = await import("./history-edit.js");

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
