// An attendance record whose service ends by a drop of the live mode straight into
// the next occurrence's arrival ramp closes at the drop.
//
// The 9am has a planned end and overruns it, so Planning Center's occurrence has
// already rolled to the 11am while the 9am is still live; the recorders hold the
// 9am record through that (shouldHoldThroughServiceTimeChange). Then the mode drops
// at 16:01, with the 11am inside the arrival ramp. SPL and the timeline close at the
// drop. The attendance record was still OPEN (it closes on a "post" tick, and a ramp
// tick is "pre"), and an open record held through the occurrence change whether or
// not anything was live: the 11am's arrivals went into the 9am record as "pre"
// samples, and its end was stamped at the ten-minute split, half an hour late.
//
// A record that covered a service now holds only while an item is live. A record
// that has only held an arrival ramp still holds while it is open.
//
// The drop cannot tell a service ending from its mode blinking. SPL and the
// timeline record nothing with no item live and decide when an item comes back;
// attendance has to put the ramp's arrivals somewhere, so it splits at the drop and
// returns to the dropped service if an item comes back while the next one is still
// more than ten minutes off, so all three agree.
//
// Driven through the real recorders' onLiveTick, with SenSource stubbed online and
// the clock mocked.
//
// Proven red: with the hold rule as it was, "the 9am record's end is not the drop";
// with the return to the dropped service removed, "the recorders disagree on which
// service the item that came back belongs to".

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { PcoLiveDTO, ServiceAttendance } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-mode-drop-ramp-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { stageController } = await import("./stage-controller.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { attendanceStore } = await import("./attendance-store.js");
const { sensourceService } = await import("./sensource-service.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

type Held = { current: ServiceAttendance | null; currentKey: string | null; lastLiveAt: number; forget(key: string): boolean };
const rec = attendanceRecorder as unknown as Held;
type Keyed = { current: { serviceKey: string; endedAt: string | null } | null; currentKey: string | null; lastLiveAt: number; forget(key: string): boolean };
const ALL: [string, Keyed][] = [
  ["spl", splRecorder as unknown as Keyed],
  ["attendance", attendanceRecorder as unknown as Keyed],
  ["timeline", serviceTimelineRecorder as unknown as Keyed],
];

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
// 22 Nov 2026 in Chicago (UTC-6): the 9am is 15:00Z, the 11am 17:00Z.
const NINE = Date.parse("2026-11-22T15:00:00.000Z");
const ELEVEN = Date.parse("2026-11-22T17:00:00.000Z");
const DROP = Date.parse("2026-11-22T16:01:00.000Z");

function live(atMs: number, occ: string, startsAt: number, itemId: string | null): PcoLiveDTO {
  return {
    mode: itemId ? "item" : "preservice",
    currentItemId: itemId,
    label: itemId,
    itemType: itemId ? "item" : null,
    lengthSec: null,
    liveStartAt: itemId ? iso(atMs) : null,
    targetAt: null,
    serverNow: iso(atMs),
    currentItemTitle: itemId,
    nextItemTitle: null,
    serviceTimeId: occ,
    serviceTimeStartsAt: iso(startsAt),
    serviceEnded: false,
    beforeServiceStart: false,
  } as PcoLiveDTO;
}

async function tick(atMs: number, occ: string, startsAt: number, itemId: string | null) {
  mock.timers.setTime(atMs);
  await attendanceRecorder.onLiveTick(live(atMs, occ, startsAt, itemId));
}

/** One tick to all three recorders, in live-poller.ts order. */
async function tickAll(atMs: number, occ: string, startsAt: number, itemId: string | null) {
  mock.timers.setTime(atMs);
  const dto = live(atMs, occ, startsAt, itemId);
  await splRecorder.onLiveTick(dto);
  await attendanceRecorder.onLiveTick(dto);
  await serviceTimelineRecorder.onLiveTick(dto);
}

describe("a mode drop straight into the next occurrence's arrival ramp", () => {
  const planId = "plan-overrun";
  const keyFor = (occ: string) => `st1:${planId}:${occ}`;

  beforeEach((t) => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    captureConsole(t as TestContext, "log", "warn", "error");
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "st1",
      serviceTypeName: "Service",
      planId,
      planTitle: "Overrun",
      planSeriesTitle: null,
    });
    (t as TestContext).mock.method(sensourceService, "getLatest", () => ({ connected: true, total: { attendance: 120, occupancy: 100 } }) as never);
    for (const [, r] of ALL) {
      r.current = null;
      r.currentKey = null;
      r.lastLiveAt = 0;
    }
  });

  afterEach(() => {
    for (const [, r] of ALL) {
      for (const occ of ["9am", "11am"]) r.forget(keyFor(occ));
      r.current = null;
      r.currentKey = null;
    }
    mock.timers.tick(61_000);
    mock.timers.reset();
  });

  it("closes the overrunning service's record at the drop, and the arrivals go to the next one", async () => {
    await tick(NINE, "9am", NINE, "welcome");
    await tick(NINE + 59 * MIN, "9am", NINE, "message");
    // Past the 9am's planned end: Planning Center already reports the 11am, and
    // the 9am record is held through it, since the 11am is an hour away.
    await tick(NINE + 60 * MIN + 30_000, "11am", ELEVEN, "message");
    assert.equal(rec.currentKey, keyFor("9am"), "the overrun was not held in the 9am record");

    // The mode drops into the 11am's arrival ramp, and arrivals keep coming.
    for (const m of [0, 4, 8, 12, 20]) await tick(DROP + m * MIN, "11am", ELEVEN, null);

    const nine = rec.currentKey === keyFor("9am") ? rec.current! : (await attendanceStore.get(keyFor("9am")))!;
    assert.equal(nine.endedAt, iso(DROP), "the 9am record's end is not the drop");
    const late = nine.samples.filter((s) => Date.parse(s.t) > DROP).map((s) => `${s.t} ${s.phase ?? "service"}`);
    assert.deepEqual(late, [], "the 11am's arrivals were sampled into the 9am record");
    assert.equal(rec.currentKey, keyFor("11am"), "the arrivals did not open the 11am record");
    assert.ok(rec.current!.samples.length >= 4 && rec.current!.samples.every((s) => s.phase === "pre"), JSON.stringify(rec.current!.samples));
  });

  it("a drop that is only a blip, with an item back while the next service is still more than ten minutes off, returns all three to the 9am", async () => {
    await tickAll(NINE, "9am", NINE, "welcome");
    await tickAll(NINE + 59 * MIN, "9am", NINE, "message");
    await tickAll(NINE + 60 * MIN + 30_000, "11am", ELEVEN, "message");
    // The mode drops for a minute, inside the 11am's ramp, and the message comes back.
    await tickAll(DROP, "11am", ELEVEN, null);
    await tickAll(DROP + 1 * MIN, "11am", ELEVEN, "message");
    await tickAll(DROP + 5 * MIN, "11am", ELEVEN, "response");

    assert.deepEqual(
      ALL.map(([name, r]) => `${name} ${r.currentKey}`),
      ALL.map(([name]) => `${name} ${keyFor("9am")}`),
      "the recorders disagree on which service the item that came back belongs to",
    );
    assert.equal(rec.current!.endedAt, null, "the 9am attendance record was not reopened");
    const after = rec.current!.samples.filter((s) => Date.parse(s.t) > DROP + 30_000);
    assert.ok(after.length >= 1 && after.every((s) => s.phase === undefined), `the rest of the 9am was not sampled into it: ${JSON.stringify(after)}`);
  });
});
