// A drop of the live mode mid-service must not hatch the rest of the service.
//
// The recorders close their records when the live DTO leaves item mode and
// reopen them on the next item tick. That stays as it is: it is what keeps a
// two-service day's first end on time and the emptying-room taper sampled.
// What went wrong is what History was left holding after the reopen:
//
//   - The attendance recorder broadcast and saved its close, but published and
//     saved its reopen only with its next people-count sample, and with
//     SenSource offline never: not after a plain reopen, not after one resumed
//     from the store following a restart, and a SERVICE END close likewise.
//     The page kept the old frame and the file the old end. It now publishes
//     and saves each of them on the tick.
//   - serviceWindowOf took that attendance end ahead of the reopened timeline's
//     running item. A running in-service item now means no end, whatever
//     attendance frame the page holds.
//
// Driven through the three real recorders' onLiveTick, with SenSource offline
// (nothing stubs it here), the records taken from what they BROADCAST
// (serialised, as the page receives them) and from disk, and passed through the
// real serviceWindowOf. The DTOs are shapes getLive can return.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { PcoLiveDTO } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-history-window-drop-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { stageController } = await import("./stage-controller.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");
const { addBroadcastListener } = await import("./broadcaster.js");
const { captureConsole } = await import("./fixtures/capture-console.js");
const { serviceWindowOf } = await import("../../renderer/settings/sections/history-chart/service-window.js");
const { sensourceService } = await import("./sensource-service.js");

type Held = { current: unknown; currentKey: string | null; lastLiveAt: number; forget(key: string): boolean };
const RECORDERS = [splRecorder, attendanceRecorder, serviceTimelineRecorder] as unknown as Held[];

type Frame = Parameters<typeof serviceWindowOf>[0]["timeline"] & { serviceKey: string };

/** What the History page holds: the last frame per record, from the SSE push. */
const page = { timeline: new Map<string, Frame>(), attendance: new Map<string, Frame>() };
let attendancePushes = 0;
addBroadcastListener((channel, payload) => {
  // Serialised, as a browser receives it. The recorders broadcast their live
  // object; holding the reference would see every later in-memory change and
  // hide a reopen that was never sent.
  const frame = JSON.parse(JSON.stringify(payload)) as Frame;
  if (channel === "service-timeline:history") page.timeline.set(frame.serviceKey, frame);
  if (channel === "attendance:history") {
    page.attendance.set(frame.serviceKey, frame);
    attendancePushes += 1;
  }
});

function windowOf(key: string) {
  return serviceWindowOf({ timeline: page.timeline.get(key) ?? null, attendance: page.attendance.get(key) ?? null });
}

/** The attendance record as saved, once the write due by now has landed.
 *  Only Date and setTimeout are mocked, so the file I/O itself is real. */
async function savedAttendanceEnd(key: string, want: string | null): Promise<string | null | undefined> {
  const file = path.join(TMP, "attendance-history", `${key.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);
  const read = async () => {
    try {
      return (JSON.parse(await fs.readFile(file, "utf8")) as { endedAt: string | null }).endedAt;
    } catch {
      return undefined;
    }
  };
  const deadline = performance.now() + 2_000;
  let got = await read();
  while (got !== want && performance.now() < deadline) {
    await new Promise((r) => setImmediate(r));
    got = await read();
  }
  return got;
}

const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

interface TickOpts {
  /** The live item, or null when getLive fell out of item mode. */
  item: string | null;
  /** When the live item went live in PCO (live_start_at). */
  itemSince?: number;
  occ?: string;
  mode?: "preservice" | "none";
  serviceTimeStartsAt?: string | null;
  serviceEnded?: boolean;
}

/** SenSource answering with a count, for the rest of the test. Offline is the
 *  default here: nothing else in this file stubs it. */
function sensourceOnline(t: TestContext, online = true): void {
  t.mock.method(sensourceService, "getLatest", () =>
    online ? { connected: true, total: { attendance: 120, occupancy: 100 } } : { connected: false, total: {} },
  );
}

/** A server restart: every recorder forgets what it held, as a fresh process
 *  would, and the next tick resumes from the store. */
function restart(): void {
  for (const rec of RECORDERS) {
    rec.current = null;
    rec.currentKey = null;
    rec.lastLiveAt = 0;
    (rec as unknown as { lastItemId: string | null }).lastItemId = null;
  }
}

/** One tick to all three recorders, in live-poller.ts order. */
async function tick(atMs: number, o: TickOpts): Promise<void> {
  mock.timers.setTime(atMs);
  const at = iso(atMs);
  const inItem = o.item != null;
  const live: PcoLiveDTO = {
    mode: inItem ? "item" : (o.mode ?? "preservice"),
    currentItemId: o.item,
    label: inItem ? o.item : "Service starts",
    itemType: inItem ? "item" : null,
    lengthSec: null,
    liveStartAt: inItem ? iso(o.itemSince ?? atMs) : null,
    targetAt: null,
    serverNow: at,
    currentItemTitle: o.item,
    nextItemTitle: null,
    serviceTimeId: o.occ ?? "occ-a",
    serviceTimeStartsAt: o.serviceTimeStartsAt ?? null,
    serviceEnded: inItem ? (o.serviceEnded ?? false) : undefined,
    beforeServiceStart: inItem ? false : undefined,
  };
  const results = await Promise.allSettled([
    splRecorder.onLiveTick(live),
    attendanceRecorder.onLiveTick(live),
    serviceTimelineRecorder.onLiveTick(live),
  ]);
  for (const r of results) if (r.status === "rejected") throw r.reason;
}

const T0 = Date.parse("2026-11-08T15:00:00.000Z");

describe("History's service window across a dropped live mode", () => {
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
      planTitle: "Mode Drop",
      planSeriesTitle: null,
    });
    for (const rec of RECORDERS) {
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
    }
    page.timeline.clear();
    page.attendance.clear();
  });

  afterEach(() => {
    for (const rec of RECORDERS) {
      for (const occ of ["occ-a", "occ-b"]) rec.forget(keyFor(occ));
      rec.current = null;
      rec.currentKey = null;
    }
    mock.timers.tick(61_000);
    mock.timers.reset();
  });

  /** A service in progress: two items, the second still running. */
  async function serviceUnderway(): Promise<number> {
    await tick(T0, { item: "song" });
    const messageAt = T0 + 10 * MIN;
    await tick(messageAt, { item: "message" });
    await tick(messageAt + 5 * MIN, { item: "message", itemSince: messageAt });
    return messageAt;
  }

  it("precondition: SenSource is offline, so no people-count sample publishes anything", () => {
    assert.equal(sensourceService.getLatest().connected, false);
  });

  it("the attendance recorder publishes and saves its reopen on the tick, with SenSource offline", async () => {
    const messageAt = await serviceUnderway();
    const dropAt = messageAt + 10 * MIN;
    const key = keyFor("occ-a");
    await tick(dropAt, { item: null, mode: "none" });
    // The drop tick itself reads as an end: on it, nothing tells it from one.
    assert.equal(page.attendance.get(key)?.endedAt, iso(dropAt));
    assert.equal(await savedAttendanceEnd(key, iso(dropAt)), iso(dropAt));

    await tick(dropAt + 5_000, { item: "message", itemSince: messageAt });
    assert.equal(
      page.attendance.get(key)?.endedAt,
      null,
      "the record reopened, but the page still holds its close frame: the reopen was never broadcast " +
        "without a people-count sample, and History hatched the rest of the service.",
    );
    mock.timers.tick(4_000); // the recorder's persist debounce
    assert.equal(
      await savedAttendanceEnd(key, null),
      null,
      "the record reopened, but the file still holds the drop as its end until the next sample, " +
        "which with SenSource offline is the real end.",
    );
    assert.equal(windowOf(key).endedAt, null);
  });

  it("a record resumed after a restart mid-service is published and saved as reopened", async () => {
    const messageAt = await serviceUnderway();
    const dropAt = messageAt + 10 * MIN;
    const key = keyFor("occ-a");
    await tick(dropAt, { item: null, mode: "none" }); // closes and saves
    assert.equal(await savedAttendanceEnd(key, iso(dropAt)), iso(dropAt));
    restart(); // the updater restarts the server inside the drop

    await tick(dropAt + 60_000, { item: "message", itemSince: messageAt });
    assert.equal(
      page.attendance.get(key)?.endedAt,
      null,
      "the resumed record's end was cleared in memory when it was resumed, before the reopen check " +
        "could see it: never broadcast, so the page kept the drop as the end.",
    );
    mock.timers.tick(4_000);
    assert.equal(await savedAttendanceEnd(key, null), null, "the resumed record's reopen was never saved");
  });

  it("a SERVICE END close is published and saved with SenSource offline", async (t) => {
    sensourceOnline(t);
    const messageAt = await serviceUnderway();
    const key = keyFor("occ-a");
    sensourceOnline(t, false); // the counter drops mid-service
    mock.timers.tick(4_000); // and the pending save flushes, with the record open
    assert.equal(await savedAttendanceEnd(key, null), null);

    const endAt = messageAt + 30 * MIN;
    await tick(endAt, { item: "service-end", serviceEnded: true });
    assert.equal(
      page.attendance.get(key)?.endedAt,
      iso(endAt),
      "SERVICE END stamped the end in memory only; with no sample to carry it, the page still shows " +
        "the service live.",
    );
    mock.timers.tick(4_000);
    assert.equal(await savedAttendanceEnd(key, iso(endAt)), iso(endAt), "the SERVICE END close was never saved");
  });

  it("a reopen with SenSource online is broadcast once", async (t) => {
    sensourceOnline(t);
    const messageAt = await serviceUnderway();
    const dropAt = messageAt + 10 * MIN;
    await tick(dropAt, { item: null, mode: "none" });
    attendancePushes = 0;
    await tick(dropAt + 5_000, { item: "message", itemSince: messageAt });
    assert.equal(attendancePushes, 1, "the reopen tick broadcast the O(n) record more than once");
    assert.equal(page.attendance.get(keyFor("occ-a"))?.endedAt, null);
  });

  it("a running timeline item holds the end off even against a stale attendance frame", async () => {
    const messageAt = await serviceUnderway();
    const dropAt = messageAt + 10 * MIN;
    const key = keyFor("occ-a");
    await tick(dropAt, { item: null, mode: "none" });
    const closeFrame = page.attendance.get(key);
    await tick(dropAt + 5_000, { item: "message", itemSince: messageAt });
    assert.equal(
      serviceWindowOf({ timeline: page.timeline.get(key), attendance: closeFrame }).endedAt,
      null,
      "the timeline reopened with the message running; the attendance close frame's end was taken " +
        "ahead of it and hatched the rest of the service.",
    );
  });

  it("a real end is still drawn at the moment the mode dropped", async () => {
    const messageAt = await serviceUnderway();
    const endAt = messageAt + 30 * MIN;
    await tick(endAt, { item: null, mode: "none" });
    for (let t = endAt + 4_000; t <= endAt + 15 * MIN; t += 60_000) await tick(t, { item: null, mode: "none" });
    assert.equal(windowOf(keyFor("occ-a")).endedAt, iso(endAt));
  });

  it("the SERVICE END header still ends it, with the item left on air", async () => {
    const messageAt = await serviceUnderway();
    const endAt = messageAt + 30 * MIN;
    await tick(endAt, { item: "service-end", serviceEnded: true });
    await tick(endAt + 60_000, { item: "service-end", itemSince: endAt, serviceEnded: true });
    assert.equal(windowOf(keyFor("occ-a")).endedAt, iso(endAt));
  });

  it("a two-service day with no SERVICE END header ends the first service when its mode dropped", async () => {
    const messageAt = await serviceUnderway();
    const dropAt = messageAt + 30 * MIN;
    const secondStarts = dropAt + 40 * MIN;
    await tick(dropAt, { item: null, mode: "none" });
    // PCO moves on to the next occurrence, 40 minutes out: the arrival ramp opens
    // the second service's record.
    for (let t = dropAt + 10_000; t < secondStarts; t += 5 * MIN) {
      await tick(t, { item: null, occ: "occ-b", serviceTimeStartsAt: iso(secondStarts) });
    }
    await tick(secondStarts, { item: "welcome", occ: "occ-b", serviceTimeStartsAt: iso(secondStarts) });

    assert.equal(windowOf(keyFor("occ-a")).endedAt, iso(dropAt), "the first service ends when its mode dropped");
    assert.equal(windowOf(keyFor("occ-b")).endedAt, null, "the second service is live");
  });
});
