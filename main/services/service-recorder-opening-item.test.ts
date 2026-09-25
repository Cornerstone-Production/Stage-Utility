// A held record splits the moment the next service's OPENING item goes live —
// not only once the ten-minute clock says so.
//
// The incident (24 Sep 2026, The Salt Company, one plan, two service times):
// occurrence 225131089 → 225131091 switched at 00:40:25Z with the 8:15pm
// occurrence 35 minutes out, so ensureRecord's overrun hold correctly kept
// record 1 open. The operator then put Doors — occurrence 1's own opening
// item — live again on the NEW occurrence at 00:42:51Z, 32 minutes before the
// ten-minute rule would have released the hold on its own. Every item of the
// second service (Doors, Pre-roll, Same God) landed in record 1 instead: the
// clock alone under-detects a next service that starts promptly.
//
// The fix lives once, in ServiceRecorder.shouldHoldThroughServiceTimeChange —
// shared by all three recorders — so this drives all three through onLiveTick,
// in the order live-poller.ts calls them, rather than picking one as a stand-in
// for the rest. SPL and attendance push no items[] the way the timeline
// recorder does, so this is also what proves each of them learns the opening
// item some other way: see openingItemId / captureOpeningItem in
// service-recorder.ts, which persist it on the record itself.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-opening-item-split-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

// Through the settings store, not setAppTimeZone: every settings read re-applies
// the saved zone (null means the host's), so a recorder that reads settings on
// its first tick silently put a UTC CI runner back on UTC and filed tonight's
// two services on two dates. A UTC box must not file these on two dates.
const { settingsStore } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { stageController } = await import("./stage-controller.js");
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { splHistoryStore } = await import("./spl-history-store.js");
const { attendanceStore } = await import("./attendance-store.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { splRecorder } = await import("./spl-recorder.js");
const { attendanceRecorder } = await import("./attendance-recorder.js");

const OCC_1 = "225131089";
const OCC_2 = "225131091";
const OCC_1_STARTS = "2026-09-24T23:15:00.000Z";
const OCC_2_STARTS = "2026-09-25T01:15:25.000Z"; // "next occurrence starts in 35 min" at 00:40:25Z

type Rec = { serviceKey: string; endedAt: string | null; openingItemId?: string | null };
type Held = {
  current: Rec | null;
  currentKey: string | null;
  lastLiveAt: number;
  loggedServiceTimeChange: string | null;
  forget(key: string): boolean;
  getCurrent(): Rec | null;
};
type Store = { get(k: string): Promise<Rec | null>; upsert(r: Rec): Promise<void>; invalidate(): void };

const RECORDERS: { name: string; rec: Held; store: Store }[] = [
  { name: "spl-recorder", rec: splRecorder as unknown as Held, store: splHistoryStore as unknown as Store },
  { name: "attendance-recorder", rec: attendanceRecorder as unknown as Held, store: attendanceStore as unknown as Store },
  { name: "service-timeline-recorder", rec: serviceTimelineRecorder as unknown as Held, store: serviceTimelineStore as unknown as Store },
];

/** One live tick, at `at` (ISO), on `occ`, fed to all three recorders in the
 *  same order live-poller.ts uses (spl, attendance, timeline). */
function tick(
  at: string,
  occ: { id: string | null; startsAt: string | null },
  item: { id: string; title: string; lengthSec?: number | null; liveStartAt?: string },
): Promise<unknown> {
  mock.timers.setTime(Date.parse(at));
  const live = {
    mode: "item" as const,
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
  };
  return Promise.all([
    splRecorder.onLiveTick(live),
    attendanceRecorder.onLiveTick(live),
    serviceTimelineRecorder.onLiveTick(live),
  ]);
}

describe("a held record splits when the next service's OPENING item goes live", () => {
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
    for (const { rec } of RECORDERS) {
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
      rec.loggedServiceTimeChange = null;
    }
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    for (const { rec } of RECORDERS) {
      rec.forget(rec.currentKey ?? "");
      rec.current = null;
      rec.currentKey = null;
    }
    mock.timers.reset();
  });

  const openingItemLogs = () => logs.filter((l) => l.includes("went live again during the hold"));
  const holdLogs = () => logs.filter((l) => l.includes("holding the open record"));

  it("closes record 1 and opens record 2 the instant Doors goes live — tonight's replay", async () => {
    const occ1 = { id: OCC_1, startsAt: OCC_1_STARTS };
    const occ2 = { id: OCC_2, startsAt: OCC_2_STARTS };

    await tick("2026-09-24T23:16:29.000Z", occ1, { id: "doors", title: "Doors" });
    await tick("2026-09-24T23:40:00.000Z", occ1, { id: "hosting", title: "HOSTING/BENNY" });
    // Service time flips 35 min ahead of occ2's start — the overrun hold.
    await tick("2026-09-25T00:40:25.000Z", occ2, { id: "hosting", title: "HOSTING/BENNY" });
    assert.equal(holdLogs().length, 3, `expected all three recorders to log the hold: ${logs.join(" | ")}`);

    // Doors — occurrence 1's OWN opening item — goes live on occ2, 32 min
    // before the ten-minute rule would have released the hold on its own.
    await tick("2026-09-25T00:42:51.000Z", occ2, { id: "doors", title: "Doors" });

    const key1 = `75953:${planId}:${OCC_1}`;
    const key2 = `75953:${planId}:${OCC_2}`;

    for (const { name, rec, store } of RECORDERS) {
      const first = await store.get(key1);
      assert.ok(first, `${name}: the first service's record is missing`);
      assert.ok(first!.endedAt, `${name}: the first record was never closed — the second service merged into it`);
      assert.equal(rec.getCurrent()?.serviceKey, key2, `${name}: did not open the second occurrence's own record`);
      assert.equal(rec.getCurrent()?.endedAt, null, `${name}: the new record was not left open`);
    }

    const timeline = serviceTimelineRecorder.getCurrent();
    assert.equal(timeline?.items.length, 1, "the second record should hold only Doors so far");
    assert.equal(timeline?.items[0]!.itemId, "doors");
    assert.equal(timeline?.items[0]!.startedAt, "2026-09-25T00:42:51.000Z", "Doors should start at THIS tick's time");

    assert.equal(
      openingItemLogs().length,
      3,
      `expected all three recorders to log the opening-item split: ${logs.join(" | ")}`,
    );
    for (const { name } of RECORDERS) {
      assert.ok(
        openingItemLogs().some((l) => l.includes(name) && l.includes(`closing ${key1}`)),
        `${name} did not log the opening-item split closing ${key1}: ${logs.join(" | ")}`,
      );
    }
  });

  it("does not split on a reprise of a DIFFERENT item during the hold", async () => {
    const occ1 = { id: OCC_1, startsAt: OCC_1_STARTS };
    const occ2 = { id: OCC_2, startsAt: OCC_2_STARTS };

    await tick("2026-09-24T23:16:29.000Z", occ1, { id: "doors", title: "Doors" });
    await tick("2026-09-24T23:24:00.000Z", occ1, { id: "song-free", title: "Thank God I'm Free" });
    await tick("2026-09-25T00:40:25.000Z", occ2, { id: "song-free", title: "Thank God I'm Free" }); // holds
    // The SAME song reprised while held — not the opening item, keeps holding.
    await tick("2026-09-25T00:41:00.000Z", occ2, { id: "song-free", title: "Thank God I'm Free" });

    const key1 = `75953:${planId}:${OCC_1}`;
    for (const { name, rec } of RECORDERS) {
      assert.equal(rec.getCurrent()?.serviceKey, key1, `${name}: split on a reprise of a non-opening item`);
    }
    assert.equal(openingItemLogs().length, 0, `no split should have been logged: ${logs.join(" | ")}`);
  });

  it("still holds through an overrun that rolls pickServiceTime on to the next occurrence — #548", async () => {
    const nine = { id: "occ-9am", startsAt: "2026-09-20T14:00:00.000Z" }; // 09:00 Chicago
    const eleven = { id: "occ-11am", startsAt: "2026-09-20T16:00:00.000Z" }; // 11:00 Chicago

    await tick("2026-09-20T14:02:00.000Z", nine, { id: "welcome", title: "Welcome" });
    await tick("2026-09-20T15:34:30.000Z", nine, { id: "welcome", title: "Welcome" });
    await tick("2026-09-20T15:35:00.000Z", eleven, { id: "closing", title: "Closing" });

    const key9 = `75953:${planId}:occ-9am`;
    for (const { name, rec } of RECORDERS) {
      assert.equal(rec.getCurrent()?.serviceKey, key9, `${name}: the overrunning service split early`);
      assert.equal(rec.getCurrent()?.endedAt, null, `${name}: the overrunning record was closed`);
    }
    assert.equal(openingItemLogs().length, 0);
    assert.equal(holdLogs().length, 3);
  });

  it("still splits by the ten-minute rule when the next service starts on a DIFFERENT item", async () => {
    const occ1 = { id: OCC_1, startsAt: OCC_1_STARTS };
    const occ2 = { id: OCC_2, startsAt: OCC_2_STARTS };

    await tick("2026-09-24T23:16:29.000Z", occ1, { id: "doors", title: "Doors" });
    await tick("2026-09-24T23:40:00.000Z", occ1, { id: "hosting", title: "HOSTING/BENNY" });
    // occ2 has already begun — the timer rule alone closes this, no opening item involved.
    await tick("2026-09-25T01:15:30.000Z", occ2, { id: "welcome", title: "Welcome" });

    const key1 = `75953:${planId}:${OCC_1}`;
    const key2 = `75953:${planId}:${OCC_2}`;
    for (const { name, rec, store } of RECORDERS) {
      const first = await store.get(key1);
      assert.ok(first?.endedAt, `${name}: the first record was never closed`);
      assert.equal(rec.getCurrent()?.serviceKey, key2, `${name}: did not split on the new occurrence`);
    }
    assert.equal(openingItemLogs().length, 0, "this split is the timer rule's, not the opening item's");
  });

  it("a restart mid-hold still splits together once Doors goes live", async () => {
    const occ1 = { id: OCC_1, startsAt: OCC_1_STARTS };
    const occ2 = { id: OCC_2, startsAt: OCC_2_STARTS };
    const key1 = `75953:${planId}:${OCC_1}`;
    const key2 = `75953:${planId}:${OCC_2}`;

    await tick("2026-09-24T23:16:29.000Z", occ1, { id: "doors", title: "Doors" });
    await tick("2026-09-24T23:40:00.000Z", occ1, { id: "hosting", title: "HOSTING/BENNY" });

    // Simulate the process restarting before the debounced persist would have
    // fired: force the write ourselves, then wipe exactly what a real restart
    // wipes — this recorder instance's in-memory state and each store's
    // in-memory cache — so the next read can only succeed off disk.
    for (const { rec, store } of RECORDERS) {
      await store.upsert(rec.getCurrent()!);
      store.invalidate();
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
      rec.loggedServiceTimeChange = null;
    }

    // First tick after the "restart": PCO still reports occurrence 1, unchanged
    // — this is what makes ensureRecord resume record 1 from disk rather than
    // opening occurrence 2 fresh with no memory of the hold at all.
    await tick("2026-09-24T23:41:00.000Z", occ1, { id: "hosting", title: "HOSTING/BENNY" });
    for (const { name, rec } of RECORDERS) {
      assert.equal(rec.getCurrent()?.serviceKey, key1, `${name}: did not resume record 1 from disk`);
      assert.equal(
        rec.getCurrent()?.openingItemId,
        "doors",
        `${name}: openingItemId did not survive the restart on disk`,
      );
    }

    // Now the occurrence flips — the hold, freshly decided post-restart.
    await tick("2026-09-25T00:40:25.000Z", occ2, { id: "hosting", title: "HOSTING/BENNY" });
    assert.equal(holdLogs().length, 3, `expected the post-restart hold to be logged: ${logs.join(" | ")}`);

    // Doors — the opening item — goes live. All three still split together.
    await tick("2026-09-25T00:42:51.000Z", occ2, { id: "doors", title: "Doors" });
    for (const { name, rec, store } of RECORDERS) {
      const first = await store.get(key1);
      assert.ok(first?.endedAt, `${name}: record 1 was never closed after the restart`);
      assert.equal(rec.getCurrent()?.serviceKey, key2, `${name}: did not split after the restart`);
    }
    assert.equal(
      openingItemLogs().length,
      3,
      `expected all three recorders to log the post-restart split: ${logs.join(" | ")}`,
    );
  });
});
