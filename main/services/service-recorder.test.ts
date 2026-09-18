// Two services on ONE plan must be two records.
//
// The incident (18 Sep 2026): a plan with two service times — 23:30Z and 01:15Z —
// produced a single record for the first occurrence containing BOTH services. PCO
// Live never left "item" mode between them (the second service's pre-service item
// went live seconds after the first service's last), so the gap between live ticks
// stayed at seconds and ensureRecord's "hold the open record through a
// serviceTimeId change" branch held all the way through. The first service's Doors
// ended up 6753 s long, a song from 23:32 was reopened and left running, and the
// second occurrence got no record at all. All three recorders share ensureRecord,
// so SPL and attendance merged identically.
//
// The hold itself is load-bearing and must survive: pickServiceTime rolls to the
// NEXT occurrence while a service runs past its planned end, and a PCO cache miss
// does the same. The split decision is therefore made on the NEW occurrence's own
// start time, not on the gap — see shouldHoldThroughServiceTimeChange.
//
// Driven through serviceTimelineRecorder.onLiveTick, the real path, with node's
// Date mock supplying the clock. The timeline recorder is the one whose items make
// a merge visible; ensureRecord under test is the shared base.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-back-to-back-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { setAppTimeZone } = await import("./app-timezone.js");
setAppTimeZone("America/Chicago"); // a UTC box must not file these on two dates

const { stageController } = await import("./stage-controller.js");
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");

const OCC_1 = "225131080";
const OCC_2 = "225131082";
const OCC_1_STARTS = "2026-09-18T23:30:00.000Z";
const OCC_2_STARTS = "2026-09-19T01:15:00.000Z";

type Held = {
  current: unknown;
  currentKey: string | null;
  lastLiveAt: number;
  lastItemId: string | null;
  forget(key: string): boolean;
};
const held = serviceTimelineRecorder as unknown as Held;

/** One live tick, at `at` (ISO), on `occ`. */
function tick(
  at: string,
  occ: { id: string | null; startsAt: string | null },
  item: { id: string; title: string; lengthSec?: number | null; liveStartAt?: string },
): Promise<void> {
  mock.timers.setTime(Date.parse(at));
  return serviceTimelineRecorder.onLiveTick({
    mode: "item",
    currentItemId: item.id,
    label: item.title,
    itemType: null,
    lengthSec: item.lengthSec ?? null,
    liveStartAt: item.liveStartAt ?? at,
    targetAt: null,
    serverNow: at,
    currentItemTitle: item.title,
    nextItemTitle: null,
    serviceTimeId: occ.id,
    serviceTimeStartsAt: occ.startsAt,
    beforeServiceStart: false,
  });
}

describe("ServiceRecorder.ensureRecord: back-to-back services on one plan", () => {
  let logs: string[] = [];
  let originalLog: typeof console.log;
  let planId = "";
  let n = 0;

  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"] }); // Date only — the debounced persist still uses a real timer
    planId = `plan-${++n}`; // a fresh key space per case, so no store entry leaks between them
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "The Salt Company",
      planId,
      planTitle: "The Man Who Didn't Risk",
      planSeriesTitle: null,
    });
    held.current = null;
    held.currentKey = null;
    held.lastLiveAt = 0;
    held.lastItemId = null;
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    // forget() cancels the debounced persist, so no 4 s timer outlives the case.
    held.forget(held.currentKey ?? "");
    held.current = null;
    held.currentKey = null;
    mock.timers.reset();
  });

  const recorderLogs = (): string[] => logs.filter((l) => l.includes("[service-recorder]"));

  it("splits when the new occurrence has already begun — the 18 Sep merge", async () => {
    const occ1 = { id: OCC_1, startsAt: OCC_1_STARTS };
    const occ2 = { id: OCC_2, startsAt: OCC_2_STARTS };

    // First service: Doors at 23:23:46Z, then the plan runs to HOSTING/BENNY.
    await tick("2026-09-18T23:23:46.000Z", occ1, { id: "doors", title: "Doors", lengthSec: 378 });
    await tick("2026-09-18T23:32:03.000Z", occ1, { id: "song-free", title: "Thank God I'm Free", lengthSec: 300 });
    await tick("2026-09-19T00:41:00.000Z", occ1, { id: "hosting", title: "HOSTING/BENNY", lengthSec: 120 });
    // The live-poller calls onLiveTick on EVERY poll, not only on a transition,
    // and PCO never left "item" mode between the two services. lastLiveAt is
    // therefore seconds old when the occurrence flips — which is exactly why the
    // tick gap could not tell the two services apart.
    await tick("2026-09-19T01:15:00.000Z", occ1, { id: "hosting", title: "HOSTING/BENNY", lengthSec: 120 });

    // pickServiceTime rolls to the 01:15 occurrence once it has started.
    await tick("2026-09-19T01:15:05.000Z", occ2, { id: "doors", title: "Doors", lengthSec: 378 });

    const key1 = `75953:${planId}:${OCC_1}`;
    const key2 = `75953:${planId}:${OCC_2}`;

    const first = await serviceTimelineStore.get(key1);
    assert.ok(first, `the first service's record is missing (key ${key1})`);
    assert.equal(first.serviceTimeId, OCC_1);
    assert.ok(first.endedAt, "the first record was never closed — the second service merged into it");
    assert.equal(first.items.length, 3, "the second service's items were written into the first record");

    // The item the merge rewrote in production: Doors read 23:23:46 → 01:16:19.
    const doors = first.items[0]!;
    assert.equal(doors.itemId, "doors");
    assert.equal(doors.startedAt, "2026-09-18T23:23:46.000Z");
    assert.equal(doors.actualDurationSec, 497, "Doors' duration was stretched across both services");
    assert.equal(
      first.items[1]!.endedAt,
      "2026-09-19T00:41:00.000Z",
      "'Thank God I'm Free' was left open by the second service reopening it",
    );

    const second = serviceTimelineRecorder.getCurrent();
    assert.equal(second?.serviceKey, key2, "the second occurrence got no record of its own");
    assert.equal(second?.endedAt, null);
    assert.equal(second?.items.length, 1);
    assert.equal(second?.items[0]!.startedAt, "2026-09-19T01:15:05.000Z");

    assert.deepEqual(recorderLogs(), [
      `[service-recorder] service-timeline-recorder: service time ${OCC_1} → ${OCC_2} began at 20:15:00, closing ${key1} and opening a new record`,
    ]);
  });

  it("holds through an overrun that rolls pickServiceTime on to the next occurrence", async () => {
    // 9am service still live at 10:35 local; the 11am occurrence is selected
    // because the 9am's plan time has ended. One service, one record.
    const nine = { id: "occ-9am", startsAt: "2026-09-20T14:00:00.000Z" }; // 09:00 Chicago
    const eleven = { id: "occ-11am", startsAt: "2026-09-20T16:00:00.000Z" }; // 11:00 Chicago

    await tick("2026-09-20T14:02:00.000Z", nine, { id: "welcome", title: "Welcome" });
    await tick("2026-09-20T15:34:30.000Z", nine, { id: "welcome", title: "Welcome" }); // the poller ticks throughout
    await tick("2026-09-20T15:35:00.000Z", eleven, { id: "closing", title: "Closing", lengthSec: 300 });

    const rec = serviceTimelineRecorder.getCurrent();
    assert.equal(rec?.serviceKey, `75953:${planId}:occ-9am`, "the overrunning service was split onto the next occurrence");
    assert.equal(rec?.items.length, 2);
    assert.equal(rec?.endedAt, null);
    assert.equal(await serviceTimelineStore.get(`75953:${planId}:occ-11am`), null, "an 11am record was opened mid-9am");

    assert.deepEqual(recorderLogs(), [
      "[service-recorder] service-timeline-recorder: service time occ-9am → occ-11am, holding the open record (next occurrence starts in 25 min)",
    ]);
  });

  it("logs the hold once, not on every tick for the length of the overrun", async () => {
    const nine = { id: "occ-9am", startsAt: "2026-09-20T14:00:00.000Z" };
    const eleven = { id: "occ-11am", startsAt: "2026-09-20T16:00:00.000Z" };

    await tick("2026-09-20T14:02:00.000Z", nine, { id: "welcome", title: "Welcome" });
    await tick("2026-09-20T15:31:00.000Z", eleven, { id: "a", title: "A" });
    await tick("2026-09-20T15:33:00.000Z", eleven, { id: "b", title: "B" });
    await tick("2026-09-20T15:35:00.000Z", eleven, { id: "c", title: "C" });

    assert.equal(recorderLogs().length, 1, `the hold was announced on every tick: ${recorderLogs().join(" | ")}`);
  });

  it("falls back to the tick gap when the new occurrence has no start time", async () => {
    // No serviceTimeStartsAt to read: today's rule, unchanged. A short gap holds.
    const a = { id: "occ-a", startsAt: null };
    const b = { id: "occ-b", startsAt: null };

    await tick("2026-09-20T14:02:00.000Z", a, { id: "welcome", title: "Welcome" });
    await tick("2026-09-20T14:04:00.000Z", b, { id: "closing", title: "Closing" });

    const rec = serviceTimelineRecorder.getCurrent();
    assert.equal(rec?.serviceKey, `75953:${planId}:occ-a`, "a start-less roll-over split the record");
    assert.equal(rec?.items.length, 2);
    assert.equal(recorderLogs().length, 0, "there is no occurrence start to report a decision about");
  });

  it("splits on a start-less occurrence once the tick gap exceeds the service gap", async () => {
    const a = { id: "occ-a", startsAt: null };
    const b = { id: "occ-b", startsAt: null };

    await tick("2026-09-20T14:02:00.000Z", a, { id: "welcome", title: "Welcome" });
    await tick("2026-09-20T16:02:00.000Z", b, { id: "welcome", title: "Welcome" });

    assert.equal(serviceTimelineRecorder.getCurrent()?.serviceKey, `75953:${planId}:occ-b`);
    const first = await serviceTimelineStore.get(`75953:${planId}:occ-a`);
    assert.ok(first?.endedAt, "the outgoing record was not closed");
  });

  it("holds when PCO reports no occurrence at all — a cache miss, not a service", async () => {
    // The record was opened against an occurrence; PCO then stops reporting one and
    // the key falls back to the date. Nothing here says a second service began.
    const occ = { id: OCC_1, startsAt: OCC_1_STARTS };
    await tick("2026-09-18T23:23:46.000Z", occ, { id: "doors", title: "Doors" });
    await tick("2026-09-18T23:30:00.000Z", { id: null, startsAt: null }, { id: "song", title: "Song" });

    assert.equal(serviceTimelineRecorder.getCurrent()?.serviceKey, `75953:${planId}:${OCC_1}`);
    assert.equal(serviceTimelineRecorder.getCurrent()?.items.length, 2);
  });

  it("holds when the record predates PCO knowing its occurrence", async () => {
    // Opened with serviceTimeId null (the key is the date); the occurrence then
    // arrives. That is the cache miss resolving, not a second service — even
    // though the occurrence has plainly already started.
    await tick("2026-09-18T23:23:46.000Z", { id: null, startsAt: null }, { id: "doors", title: "Doors" });
    await tick("2026-09-18T23:31:00.000Z", { id: OCC_1, startsAt: OCC_1_STARTS }, { id: "song", title: "Song" });

    assert.equal(serviceTimelineRecorder.getCurrent()?.serviceKey, `75953:${planId}:2026-09-18`);
    assert.equal(serviceTimelineRecorder.getCurrent()?.items.length, 2);
    assert.equal(recorderLogs().length, 0);
  });
});
