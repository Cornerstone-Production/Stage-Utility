// Records the boot-time close left half-closed before it shared the recorders'
// close are repaired once, at boot.
//
// Before v1.29.0, a server that died mid-service had its records closed at the
// next boot by a close of its own: the SPL record got an end and its items did
// not, and the timeline's last item got the record's end (its own start, give or
// take a second) and no length. reconcile-records.ts now closes the way the
// recorders do, but the records already written that way kept the gap: History's
// Actual total skipped the item, and a closed SPL record held items still
// "running".
//
// The repair applies the same rule to them (the end is the occurrence's last
// in-service people count), fills only what that rule would have written, keeps
// a copy of each record as it was beside it, and leaves anything it cannot
// measure alone. Driven through the real stores and the real
// reconcileOpenRecords, which is what boot calls.

import assert from "node:assert/strict";
import { describe, it, beforeEach, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ServiceAttendance, ServiceSplHistory, ServiceTimeline } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-reconcile-repair-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { settingsStore } = await import("./settings-store.js");
await settingsStore.patch({ timezone: "America/Chicago" });

const { reconcileOpenRecords, repairArrivedRecords } = await import("./reconcile-records.js");
const { historyRepairsStore } = await import("./history-repairs-store.js");
const { attendanceStore } = await import("./attendance-store.js");
const { splHistoryStore } = await import("./spl-history-store.js");
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-11-08T15:00:00.000Z");
/** MESSAGE went live in Planning Center here... */
const MESSAGE_LIVE = T0 + 20 * MIN;
/** ...and the recorder closed SONG from its own clock a moment later. */
const SONG_CLOSED = MESSAGE_LIVE + 2_000;
/** The server died here, mid-MESSAGE. */
const CRASH = T0 + 50 * MIN;
/** What the old boot close took for the end: the latest stamp the record held. */
const OLD_END = SONG_CLOSED;

let planN = 0;
function identity(): { serviceKey: string; planId: string } {
  const planId = `plan-${++planN}`;
  return { serviceKey: `75953:${planId}:occ-a`, planId };
}

function base(id: { serviceKey: string; planId: string }, endedAt: string | null) {
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
    endedAt,
  };
}

/** A timeline the pre-1.29.0 boot close wrote: MESSAGE ended at the record's
 *  end, which was its own start, with no length. */
function oldClosedTimeline(id: { serviceKey: string; planId: string }): ServiceTimeline {
  return {
    ...base(id, iso(OLD_END)),
    items: [
      { itemId: "song", title: "Song", sequence: 0, plannedLengthSec: 1200, startedAt: iso(T0), endedAt: iso(SONG_CLOSED), actualDurationSec: 1202 },
      { itemId: "message", title: "Message", sequence: 1, plannedLengthSec: 1800, startedAt: iso(MESSAGE_LIVE), endedAt: iso(OLD_END), actualDurationSec: null },
    ],
  };
}

/** An SPL record the pre-1.29.0 boot close wrote: the record ended, MESSAGE did not. */
function oldClosedSpl(id: { serviceKey: string; planId: string }): ServiceSplHistory {
  const item = (itemId: string, sequence: number, startedAt: number, endedAt: number | null) => ({
    itemId, title: itemId, itemType: null, sequence, metrics: {}, maxSpl: null, sampleCount: 0,
    startedAt: iso(startedAt), endedAt: endedAt == null ? null : iso(endedAt),
  });
  return {
    ...base(id, iso(OLD_END)),
    meterId: null,
    metricKey: null,
    items: [item("song", 0, T0, SONG_CLOSED), item("message", 1, MESSAGE_LIVE, null)],
  };
}

/** The same occurrence's attendance, which counted people until the crash. */
function attendance(id: { serviceKey: string; planId: string }, lastInServiceAt: number): ServiceAttendance {
  const samples = [{ t: iso(T0 - 20 * MIN), attendance: 10, occupancy: 10, phase: "pre" as const }];
  for (let at = T0; at <= lastInServiceAt; at += 5 * MIN) samples.push({ t: iso(at), attendance: 200, occupancy: 180 } as never);
  return {
    ...base(id, iso(lastInServiceAt)),
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

/** The record's file, and the copy the repair keeps of it. */
function fileOf(dir: "service-timeline" | "spl-history", key: string): string {
  return path.join(TMP, dir, `${key.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);
}
const BACKUP = ".before-repair";

const bytes = (p: string) => fs.readFile(p, "utf8");
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** A fresh boot: the repair has not run yet on this data dir. */
async function notYetRepaired(): Promise<void> {
  await historyRepairsStore.save({});
}

describe("records the old boot close left half-closed", () => {
  let lines: string[] = [];
  beforeEach(async (t) => {
    lines = captureConsole(t as TestContext, "log", "warn", "error");
    await notYetRepaired();
  });

  it("gives the timeline's last item the end and length the recorders would have written", async () => {
    const id = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(id));
    await attendanceStore.upsert(attendance(id, CRASH));
    await reconcileOpenRecords();

    const tl = await serviceTimelineStore.get(id.serviceKey);
    const message = tl?.items.find((it) => it.itemId === "message");
    assert.equal(message?.actualDurationSec, (CRASH - MESSAGE_LIVE) / 1000, "the item still has no length");
    assert.equal(message?.endedAt, iso(CRASH), "ended at the last in-service people count");
    assert.equal(tl?.endedAt, iso(CRASH), "the record ends where its last item does");
    assert.equal(tl?.items[0]?.actualDurationSec, 1202, "an item that was whole is left as it was");
    assert.ok(
      lines.some((l) => l.startsWith("[reconcile]") && l.includes(id.serviceKey) && l.includes("repaired")),
      `no [reconcile] line names the repaired record:\n${lines.join("\n")}`,
    );
  });

  it("closes the items an SPL record left open, at the same end", async () => {
    const id = identity();
    await splHistoryStore.upsert(oldClosedSpl(id));
    await attendanceStore.upsert(attendance(id, CRASH));
    await reconcileOpenRecords();

    const spl = await splHistoryStore.get(id.serviceKey);
    assert.deepEqual(
      spl?.items.map((it) => [it.itemId, it.endedAt]),
      [
        ["song", iso(SONG_CLOSED)],
        ["message", iso(CRASH)],
      ],
    );
    assert.equal(spl?.endedAt, iso(CRASH));
  });

  it("closes an SPL record's open items at its own end when nothing measured further", async () => {
    const id = identity();
    await splHistoryStore.upsert(oldClosedSpl(id));
    await reconcileOpenRecords();

    const spl = await splHistoryStore.get(id.serviceKey);
    assert.equal(spl?.items.find((it) => it.itemId === "message")?.endedAt, iso(OLD_END));
    assert.equal(spl?.endedAt, iso(OLD_END), "the record's end moved with nothing to measure it by");
  });

  it("fills an item a step back reopened, which is not the last to go live", async () => {
    // SONG, MESSAGE, back to SONG at 25 min, crash at 50. The recorders reopen
    // SONG's first entry, keeping its start, and close MESSAGE when it went.
    const id = identity();
    const back = T0 + 25 * MIN;
    const tl = oldClosedTimeline(id);
    tl.items[0] = { ...tl.items[0]!, endedAt: iso(back), actualDurationSec: null };
    tl.items[1] = { ...tl.items[1]!, endedAt: iso(back), actualDurationSec: (back - MESSAGE_LIVE) / 1000 };
    tl.endedAt = iso(back);
    await serviceTimelineStore.upsert(tl);
    const spl = oldClosedSpl(id);
    spl.items[0] = { ...spl.items[0]!, endedAt: null };
    spl.items[1] = { ...spl.items[1]!, endedAt: iso(back) };
    spl.endedAt = iso(back);
    await splHistoryStore.upsert(spl);
    await attendanceStore.upsert(attendance(id, CRASH));
    await reconcileOpenRecords();

    const song = (await serviceTimelineStore.get(id.serviceKey))?.items[0];
    assert.deepEqual([song?.endedAt, song?.actualDurationSec], [iso(CRASH), (CRASH - T0) / 1000]);
    assert.equal((await splHistoryStore.get(id.serviceKey))?.items[0]?.endedAt, iso(CRASH));
  });

  it("keeps a copy of each record as it was, beside it", async () => {
    const id = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(id));
    await splHistoryStore.upsert(oldClosedSpl(id));
    await attendanceStore.upsert(attendance(id, CRASH));
    const tlBefore = await bytes(fileOf("service-timeline", id.serviceKey));
    const splBefore = await bytes(fileOf("spl-history", id.serviceKey));
    await reconcileOpenRecords();

    assert.equal(await bytes(fileOf("service-timeline", id.serviceKey) + BACKUP), tlBefore);
    assert.equal(await bytes(fileOf("spl-history", id.serviceKey) + BACKUP), splBefore);
    assert.notEqual(await bytes(fileOf("service-timeline", id.serviceKey)), tlBefore, "the record was not repaired");
  });

  it("changes nothing the second time, and keeps the first copy", async () => {
    const id = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(id));
    await splHistoryStore.upsert(oldClosedSpl(id));
    await attendanceStore.upsert(attendance(id, CRASH));
    const original = await bytes(fileOf("service-timeline", id.serviceKey));
    await reconcileOpenRecords();
    const tlOnce = await bytes(fileOf("service-timeline", id.serviceKey));
    const splOnce = await bytes(fileOf("spl-history", id.serviceKey));

    // Forced to run again, as on a data dir whose marker was lost: the
    // records it repaired no longer have the gap it looks for.
    await notYetRepaired();
    lines.length = 0;
    await reconcileOpenRecords();

    assert.equal(await bytes(fileOf("service-timeline", id.serviceKey)), tlOnce);
    assert.equal(await bytes(fileOf("spl-history", id.serviceKey)), splOnce);
    assert.equal(await bytes(fileOf("service-timeline", id.serviceKey) + BACKUP), original, "the copy of the original was replaced");
    assert.ok(!lines.some((l) => l.includes(id.serviceKey)), `a repaired record was repaired again:\n${lines.join("\n")}`);
  });

  it("runs once: a later boot does not look again", async () => {
    await reconcileOpenRecords();
    const id = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(id));
    await attendanceStore.upsert(attendance(id, CRASH));
    const before = await bytes(fileOf("service-timeline", id.serviceKey));
    lines.length = 0;
    await reconcileOpenRecords();

    assert.equal(await bytes(fileOf("service-timeline", id.serviceKey)), before);
    assert.deepEqual(lines.filter((l) => l.includes(id.serviceKey)), []);
  });

  it("leaves a length nothing measured as it is, and says so", async () => {
    // No attendance for this occurrence: nothing saw MESSAGE run past its start.
    const id = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(id));
    const before = await bytes(fileOf("service-timeline", id.serviceKey));
    await reconcileOpenRecords();

    assert.equal(await bytes(fileOf("service-timeline", id.serviceKey)), before, "a record with nothing to measure by was rewritten");
    assert.equal(await exists(fileOf("service-timeline", id.serviceKey) + BACKUP), false);
    assert.ok(
      lines.some((l) => l.startsWith("[reconcile]") && l.includes(id.serviceKey) && l.includes("left as it is")),
      `no [reconcile] line names the record it skipped:\n${lines.join("\n")}`,
    );
  });

  it("gives an item the old close left with no end an end and no length, when nothing measured it", async () => {
    const id = identity();
    const tl = oldClosedTimeline(id);
    tl.items[1] = { ...tl.items[1]!, endedAt: null };
    await serviceTimelineStore.upsert(tl);
    await reconcileOpenRecords();

    const message = (await serviceTimelineStore.get(id.serviceKey))?.items[1];
    assert.deepEqual([message?.endedAt, message?.actualDurationSec], [iso(OLD_END), null]);
  });

  it("leaves a whole record byte for byte as it was, with no copy", async () => {
    const id = identity();
    const whole = oldClosedTimeline(id);
    whole.items[1] = { ...whole.items[1]!, endedAt: iso(CRASH), actualDurationSec: (CRASH - MESSAGE_LIVE) / 1000 };
    whole.endedAt = iso(CRASH);
    await serviceTimelineStore.upsert(whole);
    // Attendance that ran later still: a whole record is not re-closed by it.
    await attendanceStore.upsert(attendance(id, CRASH + 10 * MIN));
    const before = await bytes(fileOf("service-timeline", id.serviceKey));
    await reconcileOpenRecords();

    assert.equal(await bytes(fileOf("service-timeline", id.serviceKey)), before);
    assert.equal(await exists(fileOf("service-timeline", id.serviceKey) + BACKUP), false);
    assert.deepEqual(lines.filter((l) => l.includes(id.serviceKey)), []);
  });

  it("does not take an operator's edit for the gap", async () => {
    // A window edit closes an item at the new end and cannot measure it when
    // its start cannot be read. Every other close with a readable start
    // measures, so only that start tells this from a boot close's gap.
    const id = identity();
    const edited = oldClosedTimeline(id);
    edited.items[1] = { ...edited.items[1]!, startedAt: "not a time", endedAt: iso(CRASH - MIN) };
    edited.endedAt = iso(CRASH);
    await serviceTimelineStore.upsert(edited);
    await attendanceStore.upsert(attendance(id, CRASH + 10 * MIN));
    const before = await bytes(fileOf("service-timeline", id.serviceKey));
    await reconcileOpenRecords();

    assert.equal(await bytes(fileOf("service-timeline", id.serviceKey)), before);
  });
});

describe("what the repair never touches", () => {
  let lines: string[] = [];
  beforeEach(async (t) => {
    lines = captureConsole(t as TestContext, "log", "warn", "error");
    await notYetRepaired();
  });

  it("leaves an open record to the boot-time close", async () => {
    const id = identity();
    const open = oldClosedSpl(id);
    open.endedAt = null;
    await splHistoryStore.upsert(open);
    const openTl = oldClosedTimeline(id);
    openTl.endedAt = null;
    openTl.items[1] = { ...openTl.items[1]!, endedAt: null };
    await serviceTimelineStore.upsert(openTl);
    await attendanceStore.upsert(attendance(id, CRASH));
    await reconcileOpenRecords();

    for (const dir of ["spl-history", "service-timeline"] as const) {
      assert.equal(await exists(fileOf(dir, id.serviceKey) + BACKUP), false, `the repair rewrote an open ${dir} record`);
    }
    assert.equal((await splHistoryStore.get(id.serviceKey))?.endedAt, iso(CRASH), "the boot-time close did not close it");
    assert.equal((await serviceTimelineStore.get(id.serviceKey))?.endedAt, iso(CRASH), "the boot-time close did not close it");
    assert.ok(!lines.some((l) => l.includes(id.serviceKey) && l.includes("repaired")), lines.join("\n"));
  });

  it("does not stop the boot-time close over a record it cannot read the items of", async () => {
    const broken = identity();
    const odd = oldClosedTimeline(broken) as Partial<ServiceTimeline>;
    delete odd.items;
    await serviceTimelineStore.upsert(odd as ServiceTimeline);
    const id = identity();
    const open = oldClosedSpl(id);
    open.endedAt = null;
    await splHistoryStore.upsert(open);
    await reconcileOpenRecords();

    assert.equal((await splHistoryStore.get(id.serviceKey))?.endedAt, iso(OLD_END), "the orphan was not closed");
  });

  it("leaves a record holding more than one item the old close could have left", async () => {
    // Two old-close fragments merged in History: two items with no end. No
    // close leaves that, so there is no one item to fill.
    const id = identity();
    const spl = oldClosedSpl(id);
    spl.items[0] = { ...spl.items[0]!, endedAt: null };
    await splHistoryStore.upsert(spl);
    const tl = oldClosedTimeline(id);
    tl.items[0] = { ...tl.items[0]!, endedAt: null, actualDurationSec: null };
    await serviceTimelineStore.upsert(tl);
    await attendanceStore.upsert(attendance(id, CRASH));
    const before = [await bytes(fileOf("spl-history", id.serviceKey)), await bytes(fileOf("service-timeline", id.serviceKey))];
    await reconcileOpenRecords();

    assert.deepEqual([await bytes(fileOf("spl-history", id.serviceKey)), await bytes(fileOf("service-timeline", id.serviceKey))], before);
    assert.equal(lines.filter((l) => l.startsWith("[reconcile]") && l.includes(id.serviceKey) && l.includes("left as it is")).length, 2, lines.join("\n"));
  });

  it("does not stop the boot-time close over a null item or an open record with no items", async () => {
    const nulls = identity();
    const spl = oldClosedSpl(nulls) as unknown as { items: unknown[] };
    spl.items.unshift(null);
    await splHistoryStore.upsert(spl as unknown as ServiceSplHistory);
    const noItems = identity();
    const openOdd = oldClosedSpl(noItems) as Partial<ServiceSplHistory>;
    openOdd.endedAt = null;
    delete openOdd.items;
    await splHistoryStore.upsert(openOdd as ServiceSplHistory);
    const id = identity();
    const open = oldClosedTimeline(id);
    open.endedAt = null;
    open.items[1] = { ...open.items[1]!, endedAt: null };
    await serviceTimelineStore.upsert(open);
    await reconcileOpenRecords();

    assert.ok((await serviceTimelineStore.get(id.serviceKey))?.endedAt, "the timeline orphan was not closed");
    assert.ok((await splHistoryStore.get(noItems.serviceKey))?.endedAt, "the SPL orphan was not closed");
  });

  it("closes the orphans, then fails the boot step, when the repair throws", async (t) => {
    t.mock.method(historyRepairsStore, "update", async () => {
      throw new Error("marker disk full");
    });
    const id = identity();
    const open = oldClosedSpl(id);
    open.endedAt = null;
    await splHistoryStore.upsert(open);

    await assert.rejects(reconcileOpenRecords(), /marker disk full/);
    assert.equal((await splHistoryStore.get(id.serviceKey))?.endedAt, iso(OLD_END), "the orphan was not closed");
    assert.ok(lines.some((l) => l.startsWith("[reconcile]") && l.includes("marker disk full")), lines.join("\n"));
  });

  it("never moves a record's end earlier", async () => {
    // An end later than anything attendance saw (an operator's window edit):
    // the item it left open closes where attendance last saw the service, as
    // the recorder's close would have, and the record's end stays.
    const id = identity();
    const spl = oldClosedSpl(id);
    spl.endedAt = iso(CRASH + 20 * MIN);
    await splHistoryStore.upsert(spl);
    await attendanceStore.upsert(attendance(id, CRASH));
    await reconcileOpenRecords();

    const after = await splHistoryStore.get(id.serviceKey);
    assert.equal(after?.endedAt, iso(CRASH + 20 * MIN));
    assert.equal(after?.items[1]?.endedAt, iso(CRASH));
  });

  it("tries again next boot when a record could not be saved, and repairs the rest", async (t) => {
    const failing = identity();
    const fine = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(failing));
    await serviceTimelineStore.upsert(oldClosedTimeline(fine));
    await attendanceStore.upsert(attendance(failing, CRASH));
    await attendanceStore.upsert(attendance(fine, CRASH));
    await splHistoryStore.upsert(oldClosedSpl(failing));
    const real = serviceTimelineStore.replaceKeepingPrior.bind(serviceTimelineStore);
    const mocked = t.mock.method(serviceTimelineStore, "replaceKeepingPrior", async (rec: ServiceTimeline, suffix: string) => {
      if (rec.serviceKey === failing.serviceKey) throw new Error("disk full");
      return real(rec, suffix);
    });
    const realSpl = splHistoryStore.replaceKeepingPrior.bind(splHistoryStore);
    const mockedSpl = t.mock.method(splHistoryStore, "replaceKeepingPrior", async (rec: ServiceSplHistory, suffix: string) => {
      if (rec.serviceKey === failing.serviceKey) throw new Error("disk full");
      return realSpl(rec, suffix);
    });
    await reconcileOpenRecords();

    assert.equal((await serviceTimelineStore.get(fine.serviceKey))?.endedAt, iso(CRASH), "one failure stopped the rest");
    assert.ok(
      lines.some((l) => l.startsWith("[reconcile]") && l.includes(failing.serviceKey) && l.includes("disk full")),
      `the failed save was not logged:\n${lines.join("\n")}`,
    );
    const failed = await serviceTimelineStore.get(failing.serviceKey);
    assert.equal(failed?.items[1]?.actualDurationSec, null, "the cached record changed although its save failed");
    assert.equal((await splHistoryStore.get(failing.serviceKey))?.items[1]?.endedAt, null, "the cached SPL record changed although its save failed");

    mocked.mock.restore();
    mockedSpl.mock.restore();
    await reconcileOpenRecords();
    assert.equal((await serviceTimelineStore.get(failing.serviceKey))?.endedAt, iso(CRASH), "not tried again on the next boot");
  });
});

describe("gaps something else hid, or brought in after the boot repair ran", () => {
  let lines: string[] = [];
  beforeEach(async (t) => {
    lines = captureConsole(t as TestContext, "log", "warn", "error");
    await notYetRepaired();
  });

  it("finds the gap in a record whose window was extended since", async () => {
    // Edit times moved the record's end later; the item the old close left
    // keeps the end it had, which is no longer the record's.
    const id = identity();
    const tl = oldClosedTimeline(id);
    tl.endedAt = iso(CRASH + 30 * MIN);
    await serviceTimelineStore.upsert(tl);
    await attendanceStore.upsert(attendance(id, CRASH));
    await reconcileOpenRecords();

    const after = await serviceTimelineStore.get(id.serviceKey);
    assert.deepEqual([after?.items[1]?.endedAt, after?.items[1]?.actualDurationSec], [iso(CRASH), (CRASH - MESSAGE_LIVE) / 1000]);
    assert.equal(after?.endedAt, iso(CRASH + 30 * MIN), "the operator's end moved");
  });

  it("leaves an item with no length that was not the one on air at the end", async () => {
    // Resumed after the old close on another item: the old item keeps its
    // stamp, and later items run past it. Nothing says how long it ran.
    const id = identity();
    const tl = oldClosedTimeline(id);
    tl.items.push({ itemId: "closing", title: "Closing", sequence: 2, plannedLengthSec: 600, startedAt: iso(CRASH + 5 * MIN), endedAt: iso(CRASH + 15 * MIN), actualDurationSec: 600 });
    tl.endedAt = iso(CRASH + 15 * MIN);
    await serviceTimelineStore.upsert(tl);
    // People counted past every stamp: enough to fill the item on air, if
    // MESSAGE were taken for it.
    await attendanceStore.upsert(attendance(id, CRASH + 20 * MIN));
    const before = await bytes(fileOf("service-timeline", id.serviceKey));
    await reconcileOpenRecords();

    assert.equal(await bytes(fileOf("service-timeline", id.serviceKey)), before);
    assert.ok(lines.some((l) => l.startsWith("[reconcile]") && l.includes(id.serviceKey) && l.includes("left as it is")), lines.join("\n"));
  });

  it("keeps a rebuilt record's unknown length unknown, and repairs it by the same rule", async () => {
    const id = identity();
    await reconcileOpenRecords(); // the boot repair has run; the marker is set
    const tl = oldClosedTimeline(id);
    await serviceTimelineStore.upsert(tl);
    await attendanceStore.upsert(attendance(id, CRASH));
    const { rebuildTimelineRecord } = await import("./archive/rebuild.js");
    const rows = [
      { at: iso(T0), source: "pco", kind: "item", detail: "Song", itemId: "song" },
      { at: iso(MESSAGE_LIVE), source: "pco", kind: "item", detail: "Message", itemId: "message" },
    ];
    const rebuilt = rebuildTimelineRecord(tl, rows as never);
    assert.equal(rebuilt.items[1]?.actualDurationSec, null, "the rebuild measured MESSAGE from the old close's guessed end");

    const { serviceDirPath } = await import("./archive/archive-paths.js");
    const dir = serviceDirPath(id.serviceKey, "2026-11-08");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "events.csv"), ["at,source,kind,detail,itemId", ...rows.map((r) => `${r.at},${r.source},${r.kind},${r.detail},${r.itemId}`), ""].join("\n"));
    const { rebuildServiceRecords } = await import("./history-edit.js");
    await rebuildServiceRecords(id.serviceKey);

    const after = await serviceTimelineStore.get(id.serviceKey);
    assert.deepEqual([after?.items[1]?.endedAt, after?.items[1]?.actualDurationSec], [iso(CRASH), (CRASH - MESSAGE_LIVE) / 1000]);
  });

  it("repairs records an archive import brings in after the boot repair ran", async () => {
    const id = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(id));
    await splHistoryStore.upsert(oldClosedSpl(id));
    await attendanceStore.upsert(attendance(id, CRASH));
    const { buildArchive, importArchive } = await import("./archive/archive-bundle.js");
    const zip = await buildArchive();
    for (const store of [serviceTimelineStore, splHistoryStore, attendanceStore]) await store.delete(id.serviceKey);
    await historyRepairsStore.save({ "old-boot-close-gaps": iso(T0) }); // ran before this import

    const result = await importArchive(zip);
    assert.ok(result.added.includes(id.serviceKey));
    const tl = await serviceTimelineStore.get(id.serviceKey);
    assert.deepEqual([tl?.items[1]?.endedAt, tl?.items[1]?.actualDurationSec], [iso(CRASH), (CRASH - MESSAGE_LIVE) / 1000]);
    assert.equal((await splHistoryStore.get(id.serviceKey))?.items[1]?.endedAt, iso(CRASH));
    assert.ok(result.gapsRepaired?.includes(id.serviceKey), "the import result does not say which records it repaired");
  });
});

describe("records that arrive after the boot repair ran, when their repair cannot finish", () => {
  beforeEach(async (t) => {
    captureConsole(t as TestContext, "log", "warn", "error");
    await historyRepairsStore.save({ "old-boot-close-gaps": iso(T0) });
  });
  it("hands a repair that waits on the people counts to the next start", async (t) => {
    const { StoreReadError } = await import("./data-store.js");
    t.mock.method(attendanceStore, "unreadable", () => new StoreReadError("a file in attendance-history", new Error("EIO")));
    const result = await repairArrivedRecords(new Set(["any"]));
    assert.ok(result.waiting);
    assert.equal((await historyRepairsStore.load())["old-boot-close-gaps"], undefined, "the next start will not try again");
  });

  it("hands a repair whose save failed to the next start", async (t) => {
    const id = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(id));
    await attendanceStore.upsert(attendance(id, CRASH));
    t.mock.method(serviceTimelineStore, "replaceKeepingPrior", async () => {
      throw new Error("disk full");
    });
    const result = await repairArrivedRecords(new Set([id.serviceKey]));
    assert.deepEqual(result.failed, [id.serviceKey]);
    assert.equal((await historyRepairsStore.load())["old-boot-close-gaps"], undefined, "the next start will not try again");
  });

  it("hands a repair that threw to the next start, and still throws", async (t) => {
    t.mock.method(attendanceStore, "list", async () => {
      throw new Error("EIO listing");
    });
    await assert.rejects(repairArrivedRecords(new Set(["any"])), /EIO listing/);
    assert.equal((await historyRepairsStore.load())["old-boot-close-gaps"], undefined, "the next start will not try again");
  });

  it("leaves the marker when it finished", async () => {
    await repairArrivedRecords(new Set(["nothing-here"]));
    assert.ok((await historyRepairsStore.load())["old-boot-close-gaps"]);
  });
});

describe("a history store not all read", () => {
  beforeEach(async (t) => {
    captureConsole(t as TestContext, "log", "warn", "error");
    await notYetRepaired();
  });

  it("is not marked done, so the records it could not read are looked at next boot", async (t) => {
    const { StoreReadError } = await import("./data-store.js");
    t.mock.method(serviceTimelineStore, "unreadable", () => new StoreReadError("a file in service-timeline", new Error("EIO")));
    await reconcileOpenRecords();
    assert.equal((await historyRepairsStore.load())["old-boot-close-gaps"], undefined);
  });
});

// Last in the file: a record file that will not parse is held unread until the
// process exits, so every later test would run with the witness incomplete.
describe("with the people counts not all read", () => {
  let lines: string[] = [];
  beforeEach(async (t) => {
    lines = captureConsole(t as TestContext, "log", "warn", "error");
    await notYetRepaired();
  });

  it("writes nothing and tries again next boot", async () => {
    const id = identity();
    await serviceTimelineStore.upsert(oldClosedTimeline(id));
    await splHistoryStore.upsert(oldClosedSpl(id));
    const before = [await bytes(fileOf("service-timeline", id.serviceKey)), await bytes(fileOf("spl-history", id.serviceKey))];
    await fs.writeFile(path.join(TMP, "attendance-history", "zz-unreadable.json"), "{ not json");
    attendanceStore.invalidate();
    await reconcileOpenRecords();

    assert.deepEqual([await bytes(fileOf("service-timeline", id.serviceKey)), await bytes(fileOf("spl-history", id.serviceKey))], before);
    assert.equal((await historyRepairsStore.load())["old-boot-close-gaps"], undefined, "marked done without the witness");
    assert.ok(lines.some((l) => l.startsWith("[reconcile]") && l.includes("not repaired while an attendance record cannot be read")), lines.join("\n"));
  });
});
