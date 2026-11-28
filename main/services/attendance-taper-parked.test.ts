// The attendance taper ends when its window does, however long PCO stays parked.
//
// Every service ends the same way: the operator steps onto the item below the
// plan's SERVICE END header and Planning Center stays in that item, live, until
// somebody moves it. The tick that reaches that item closes the attendance record
// and starts the post-service taper, the emptying room, for the configured window.
//
// The window was not what stopped it. While parked, every tick still classified
// as "post" (the start window, not the taper, answered it), so the recorder kept
// appending taper samples for as long as the plan sat there: until the next
// service time rolled over, or 12 h past the start. With the taper switched off it
// sampled all the same. Past the window SenSource is no longer polled fast for
// this recorder either, so those samples were counts up to a minute stale, and the
// next unrelated edit of the service window deleted them all.
//
// Driven through the real recorder's onLiveTick with SenSource answering, in the
// shape getLive returns, the samples read from the record it holds.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { PcoLiveDTO, ServiceAttendance } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-attendance-taper-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore, DEFAULT_TAPER_WINDOW } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { stageController } = await import("./stage-controller.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { sensourceService } = await import("./sensource-service.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

type Held = {
  current: ServiceAttendance | null;
  currentKey: string | null;
  lastLiveAt: number;
  forget(key: string): boolean;
};
const recorder = attendanceRecorder as unknown as Held;

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-11-08T15:00:00.000Z");
const SERVICE_END = T0 + 60 * MIN;

/** One live tick on an item, at `atMs`. */
async function tick(atMs: number, itemId: string, opts: { since?: number; serviceEnded?: boolean } = {}): Promise<void> {
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
    serviceTimeId: "occ-a",
    serviceTimeStartsAt: iso(T0),
    serviceEnded: opts.serviceEnded ?? false,
    beforeServiceStart: false,
  };
  await attendanceRecorder.onLiveTick(live);
}

/** No item live, Planning Center counting down to occurrence `occ` at `startsAt`. */
async function preserviceTick(atMs: number, occ: string, startsAt: number): Promise<void> {
  mock.timers.setTime(atMs);
  await attendanceRecorder.onLiveTick({
    mode: "preservice",
    currentItemId: null,
    label: "Service starts",
    itemType: null,
    lengthSec: null,
    liveStartAt: null,
    targetAt: iso(startsAt),
    serverNow: iso(atMs),
    currentItemTitle: null,
    nextItemTitle: null,
    serviceTimeId: occ,
    serviceTimeStartsAt: iso(startsAt),
  } as PcoLiveDTO);
}

/** A service, then the operator steps past SERVICE END and leaves it there. */
async function serviceThenParked(): Promise<void> {
  await tick(T0, "song");
  await tick(T0 + 20 * MIN, "message");
  await tick(SERVICE_END, "dismissal", { serviceEnded: true });
}

const samplesAfter = (ms: number) => (recorder.current?.samples ?? []).filter((s) => Date.parse(s.t) > ms);
const samplesAt = (ms: number) => (recorder.current?.samples ?? []).filter((s) => Date.parse(s.t) === ms);

describe("attendance parked past SERVICE END", () => {
  let planId = "";
  let n = 0;

  beforeEach((t) => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    captureConsole(t as TestContext, "log", "warn", "error");
    (t as TestContext).mock.method(sensourceService, "getLatest", () => ({
      connected: true,
      total: { attendance: 300, occupancy: 250 },
    }));
    planId = `plan-${++n}`;
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "Service",
      planId,
      planTitle: "Parked",
      planSeriesTitle: null,
    });
    recorder.current = null;
    recorder.currentKey = null;
    recorder.lastLiveAt = 0;
  });

  afterEach(async () => {
    recorder.forget(`75953:${planId}:occ-a`);
    recorder.current = null;
    recorder.currentKey = null;
    mock.timers.tick(61_000);
    mock.timers.reset();
    await settingsStore.patch({ taperWindow: DEFAULT_TAPER_WINDOW });
  });

  it("samples the taper for the configured window, and nothing after it", async () => {
    await settingsStore.patch({ taperWindow: { preMin: 60, postMin: 60 } });
    await serviceThenParked();
    assert.equal(recorder.current?.endedAt, iso(SERVICE_END), "the SERVICE END tick closes the record");

    for (const m of [10, 30, 59]) await tick(SERVICE_END + m * MIN, "dismissal", { since: SERVICE_END, serviceEnded: true });
    const inWindow = samplesAfter(SERVICE_END).length;
    assert.equal(inWindow, 3, "one taper sample per tick inside the window");
    assert.ok(samplesAfter(SERVICE_END).every((s) => s.phase === "post"));

    for (const m of [61, 90, 120, 240]) await tick(SERVICE_END + m * MIN, "dismissal", { since: SERVICE_END, serviceEnded: true });
    assert.equal(
      samplesAfter(SERVICE_END).length,
      inWindow,
      "a sample was appended after the taper window closed",
    );
    assert.equal(recorder.current?.endedAt, iso(SERVICE_END), "the record's end did not move");
  });

  it("with the taper off, keeps the closing tick's sample and takes no more", async () => {
    await settingsStore.patch({ taperWindow: { preMin: 60, postMin: 0 } });
    await serviceThenParked();
    // The tick that reaches SERVICE END still records what the room held at the
    // close: it is the last reading of the service, and the boundary is inside a
    // zero-length window.
    assert.equal(samplesAt(SERVICE_END).length, 1, "the closing tick's own sample");

    for (const m of [1, 10, 30]) await tick(SERVICE_END + m * MIN, "dismissal", { since: SERVICE_END, serviceEnded: true });
    assert.equal(samplesAfter(SERVICE_END).length, 0, "sampled a taper that is switched off");
  });

  it("records the next service's arrival ramp in its own record, never in the finished one", async () => {
    // The 9am ends, Planning Center drops out of its items, and later counts
    // down to the 11am. The ramp ticks name the 11am's occurrence; the recorder
    // used to hold the 9am's CLOSED record through that service-time change,
    // as it holds an open record through an overrun, and appended the 11am's
    // arrivals to the 9am after its end.
    await settingsStore.patch({ taperWindow: { preMin: 60, postMin: 0 } });
    await tick(T0, "song");
    await tick(T0 + 20 * MIN, "message");
    const dropped = T0 + 61 * MIN;
    await preserviceTick(dropped, "occ-a", T0); // past the ramp grace, taper off: the 9am closes
    assert.equal(recorder.current?.endedAt, iso(dropped));

    const nextStart = T0 + 150 * MIN;
    await preserviceTick(nextStart - 40 * MIN, "occ-b", nextStart);
    await preserviceTick(nextStart - 30 * MIN, "occ-b", nextStart);

    const first = await attendanceRecorder.getRecord(`75953:${planId}:occ-a`);
    const late = (first?.samples ?? []).filter((x) => Date.parse(x.t) > dropped).map((x) => x.t);
    assert.deepEqual(late, [], "the next service's arrivals were appended to the finished one");
    assert.equal(recorder.current?.serviceKey, `75953:${planId}:occ-b`, "the ramp opened the next service's record");
    assert.equal(recorder.current?.samples.filter((x) => x.phase === "pre").length, 2);
    recorder.forget(`75953:${planId}:occ-b`);
  });
});
