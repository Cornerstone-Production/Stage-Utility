// A save that fails at the service split must not stop the next service being
// recorded, and must not lose the service that just closed.
//
// ensureRecord's split path saved the outgoing record and only then switched to
// the incoming one. When that write threw (record folder unwritable, disk full)
// onLiveTick rejected with currentKey unchanged, and every later tick took the
// same path and threw again: the next service was never recorded until the
// write succeeded. The three "left item mode" closes awaited their write the
// same way and skipped the close broadcast when it failed.
//
// Driven through the three real recorders' onLiveTick with the record folders
// made read-only on disk (chmod 500), the failure an operator actually hits —
// see service-recorder-split-broadcast.test.ts for the shape of the tick.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-split-save-"));
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
const { serviceTimelineStore } = await import("./service-timeline-store.js");
const { attendanceStore } = await import("./attendance-store.js");
const { splHistoryStore } = await import("./spl-history-store.js");
const { editServiceWindow, deleteServiceRecords } = await import("./history-edit.js");
const { buildArchive, importArchive } = await import("./archive/archive-bundle.js");
const { archiveRoutes } = await import("./routes/archive-routes.js");
const { callRoute } = await import("./routes/route-harness.js");
const { handlerErrorStatus, handlerErrorCode } = await import("./remote-server.js");

type Rec = { serviceKey: string; endedAt: string | null; startedAt?: string };
type Held = {
  current: Rec | null;
  currentKey: string | null;
  lastLiveAt: number;
  forget(key: string): boolean;
  getCurrent(): Rec | null;
  getRecord(key: string): Promise<Rec | null>;
  isHolding(key: string): boolean;
};

const RECORDERS: { name: string; dir: string; channel: string; rec: Held }[] = [
  { name: "spl-recorder", dir: "spl-history", channel: "spl:history", rec: splRecorder as unknown as Held },
  {
    name: "attendance-recorder",
    dir: "attendance-history",
    channel: "attendance:history",
    rec: attendanceRecorder as unknown as Held,
  },
  {
    name: "service-timeline-recorder",
    dir: "service-timeline",
    channel: "service-timeline:history",
    rec: serviceTimelineRecorder as unknown as Held,
  },
];

/** Longer than every recorder's retry interval (SPL's is the longest, 60 s). */
const PAST_EVERY_RETRY_MS = 61_000;

let pushes: { channel: string; payload: Rec }[] = [];
addBroadcastListener((channel, payload) => {
  pushes.push({ channel, payload: payload as Rec });
});

function liveAt(at: string, occ: string, item: string | null) {
  return {
    mode: item ? ("item" as const) : ("none" as const),
    currentItemId: item,
    label: item,
    itemType: null,
    lengthSec: null,
    liveStartAt: item ? at : null,
    targetAt: null,
    serverNow: at,
    currentItemTitle: item,
    nextItemTitle: null,
    serviceTimeId: occ,
    serviceTimeStartsAt: null,
    beforeServiceStart: false,
  };
}

/** One tick to all three recorders, in live-poller.ts order. Each is settled
 *  separately so a rejection shows which recorder threw. */
async function tick(at: string, occ: string, item: string | null): Promise<PromiseSettledResult<void>[]> {
  mock.timers.setTime(Date.parse(at));
  const live = liveAt(at, occ, item);
  return Promise.allSettled([
    splRecorder.onLiveTick(live),
    attendanceRecorder.onLiveTick(live),
    serviceTimelineRecorder.onLiveTick(live),
  ]);
}

/** keyed-record-store.ts's safeName, for the keys used here. */
function fileFor(dir: string, key: string): string {
  return path.join(TMP, dir, `${key.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);
}

async function readRecord(dir: string, key: string): Promise<Rec | null> {
  try {
    return JSON.parse(await fs.readFile(fileFor(dir, key), "utf8")) as Rec;
  } catch {
    return null;
  }
}

async function setWritable(writable: boolean): Promise<void> {
  for (const { dir } of RECORDERS) {
    await fs.mkdir(path.join(TMP, dir), { recursive: true });
    await fs.chmod(path.join(TMP, dir), writable ? 0o700 : 0o500);
  }
}

/** One turn of the event loop. Only setTimeout and Date are mocked, so this
 *  still yields to real file I/O. */
const settle = () => new Promise((r) => setImmediate(r));

/** Wait out any write already queued on the three stores: each store runs its
 *  writes one at a time, so a write queued now finishes after them. */
async function drainStores(): Promise<void> {
  const barrier = { serviceKey: "barrier", startedAt: "2026-10-18T00:00:00.000Z" } as never;
  const stores = [serviceTimelineStore, attendanceStore, splHistoryStore];
  try {
    await Promise.all(stores.map((s) => s.upsert(barrier)));
  } finally {
    await Promise.allSettled(stores.map((s) => s.delete("barrier")));
  }
}

/** Fire every retry timer, then let the real file writes they start finish. */
async function runRetries(until: () => Promise<boolean>): Promise<void> {
  mock.timers.tick(PAST_EVERY_RETRY_MS);
  const deadline = performance.now() + 5_000;
  while (!(await until()) && performance.now() < deadline) await settle();
}

const asRoot = process.getuid?.() === 0;

describe("a failed save at the service split", { skip: asRoot && "chmod does not stop root writing" }, () => {
  let planId = "";
  let n = 0;
  let errors: string[] = [];
  let logs: string[] = [];

  beforeEach(async (t) => {
    mock.timers.enable({ apis: ["Date", "setTimeout"] });
    errors = captureConsole(t as TestContext, "error");
    logs = captureConsole(t as TestContext, "log");
    planId = `plan-${++n}`;
    (stageController as unknown as { getState(): unknown }).getState = () => ({
      serviceTypeId: "75953",
      serviceTypeName: "The Gathering",
      planId,
      planTitle: "Split Save",
      planSeriesTitle: null,
    });
    for (const { rec } of RECORDERS) {
      rec.current = null;
      rec.currentKey = null;
      rec.lastLiveAt = 0;
    }
    pushes = [];
    await setWritable(true);
  });

  afterEach(async () => {
    await setWritable(true);
    for (const { rec } of RECORDERS) {
      rec.forget(`75953:${planId}:occ-a`);
      rec.forget(`75953:${planId}:occ-b`);
      rec.forget(`75953:${planId}:occ-c`);
      rec.current = null;
      rec.currentKey = null;
    }
    // Run the retry timer out with nothing held, so it is not left pending on
    // these singletons when the mocked timers are dropped.
    mock.timers.tick(PAST_EVERY_RETRY_MS);
    mock.timers.reset();
  });

  it("opens the next service's record on the same tick, and saves the outgoing one once it can", async () => {
    const key1 = `75953:${planId}:occ-a`;
    const key2 = `75953:${planId}:occ-b`;

    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await setWritable(false);
    // Past SERVICE_GAP_MS on a start-less occurrence: an unconditional split.
    const results = await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome");

    for (const [i, { name, channel, rec }] of RECORDERS.entries()) {
      assert.equal(results[i]!.status, "fulfilled", `${name}: the split tick threw`);
      assert.equal(rec.getCurrent()?.serviceKey, key2, `${name}: did not open the next service's record`);
      const closed = pushes.find((p) => p.channel === channel && p.payload.serviceKey === key1 && p.payload.endedAt);
      assert.ok(closed, `${name}: never broadcast ${key1} closed`);
      const held = await rec.getRecord(key1);
      assert.ok(held?.endedAt, `${name}: getRecord does not answer with the closed copy it is holding`);
      assert.equal(await readRecord(RECORDERS[i]!.dir, key1), null, `${name}: wrote through a read-only folder?`);
      assert.ok(
        errors.some((e) => e.includes(`[${name}]`) && e.includes("could not save")),
        `${name}: the failed save was not logged on its tag`,
      );
    }

    // Still unwritable on the next tick: nothing throws, nothing moves back.
    const next = await tick("2026-10-18T16:05:01.000Z", "occ-b", "welcome");
    for (const [i, { name, rec }] of RECORDERS.entries()) {
      assert.equal(next[i]!.status, "fulfilled", `${name}: the tick after a failed split threw`);
      assert.equal(rec.getCurrent()?.serviceKey, key2, `${name}: fell back off the next service`);
    }

    // Retries that keep failing are mentioned again, but not on every attempt.
    const stillFailing = (name: string) => errors.filter((e) => e.includes(`[${name}] still could not save`)).length;
    mock.timers.tick(PAST_EVERY_RETRY_MS);
    await drainStores().catch(() => {});
    for (const { name } of RECORDERS) assert.equal(stillFailing(name), 0, `${name}: repeated within ten minutes`);
    mock.timers.setTime(Date.parse("2026-10-18T16:20:00.000Z"));
    await runRetries(async () => RECORDERS.every(({ name }) => stillFailing(name) > 0));
    for (const { name } of RECORDERS) assert.equal(stillFailing(name), 1, `${name}: never said the save is still failing`);

    await setWritable(true);
    await runRetries(async () => {
      for (const { dir } of RECORDERS) if (!(await readRecord(dir, key1))?.endedAt) return false;
      return true;
    });
    for (const { name, dir } of RECORDERS) {
      const saved = await readRecord(dir, key1);
      assert.ok(saved?.endedAt, `${name}: the outgoing record never reached disk once the folder was writable`);
      assert.ok(
        logs.some((l) => l.includes(`[${name}]`) && l.includes(`saved ${key1}`)),
        `${name}: the late save was not logged`,
      );
    }
  });

  it("broadcasts and keeps a record closed by leaving item mode, when its save fails", async () => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await setWritable(false);
    const results = await tick("2026-10-18T15:10:00.000Z", "occ-a", null);

    for (const [i, { name, channel, rec, dir }] of RECORDERS.entries()) {
      assert.equal(results[i]!.status, "fulfilled", `${name}: the closing tick threw`);
      assert.ok(
        pushes.some((p) => p.channel === channel && p.payload.serviceKey === key1 && p.payload.endedAt),
        `${name}: never broadcast the close`,
      );
      assert.ok((await rec.getRecord(key1))?.endedAt, `${name}: getRecord lost the closed record`);
      assert.equal(await readRecord(dir, key1), null);
    }

    await setWritable(true);
    await runRetries(async () => {
      for (const { dir } of RECORDERS) if (!(await readRecord(dir, key1))?.endedAt) return false;
      return true;
    });
    for (const { name, dir } of RECORDERS) {
      assert.ok((await readRecord(dir, key1))?.endedAt, `${name}: the closed record never reached disk`);
    }
  });

  it("drops a held record that is forgotten, rather than writing a deleted service back", async () => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await setWritable(false);
    await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome");
    for (const { rec } of RECORDERS) rec.forget(key1);

    await setWritable(true);
    mock.timers.tick(PAST_EVERY_RETRY_MS);
    await drainStores();
    for (const { name, dir } of RECORDERS) {
      assert.equal(await readRecord(dir, key1), null, `${name}: wrote a forgotten record back`);
    }
  });

  it("resumes the held copy, not the older one on disk, when the same service comes back", async () => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await setWritable(false);
    await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome");
    // Back to the first occurrence after another gap. Nothing for it reached
    // disk, so only the held copy knows it started at 14:00.
    await tick("2026-10-18T18:10:00.000Z", "occ-a", "doors");
    const resumed = serviceTimelineRecorder.getCurrent();
    assert.equal(resumed?.serviceKey, key1);
    assert.equal(resumed?.startedAt, "2026-10-18T14:00:00.000Z", "opened a fresh record instead of resuming the held one");
  });

  it("does not reopen the closed record when a held one is forgotten mid-split", async () => {
    const keyB = `75953:${planId}:occ-b`;
    const keyC = `75953:${planId}:occ-c`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await setWritable(false);
    await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome-b");
    await setWritable(true);

    // The operator deletes occ-a while the occ-c split is saving occ-b.
    const splitting = tick("2026-10-18T18:10:00.000Z", "occ-c", "welcome-c");
    for (const { rec } of RECORDERS) rec.forget(`75953:${planId}:occ-a`);
    await splitting;

    const timeline = serviceTimelineRecorder.getCurrent();
    assert.equal(timeline?.serviceKey, keyC, "abandoned the split to the next service");
    const closed = (await serviceTimelineRecorder.getRecord(keyB))!;
    assert.ok(closed.endedAt, "the closed record was reopened");
    assert.deepEqual(
      closed.items.map((it) => it.itemId),
      ["welcome-b"],
      "the next service's item went into the closed record",
    );
  });

  it("refuses a history edit or an import over a held service, keeping the held copy", async () => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    // An archive holding this service, taken before it was ever saved here.
    await splHistoryStore.upsert(splRecorder.getCurrent()!);
    const zip = await buildArchive();
    await splHistoryStore.delete(key1);

    await setWritable(false);
    await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome");
    await setWritable(true);

    await assert.rejects(
      () => editServiceWindow(key1, { endedAt: "2026-10-18T15:00:00.000Z" }),
      (err: Error & { code?: string }) => err.code === "unsaved",
    );
    await assert.rejects(() => deleteServiceRecords(key1), (err: Error & { code?: string }) => err.code === "unsaved");
    await assert.rejects(() => importArchive(zip), (err: Error & { code?: string }) => err.code === "unsaved");
    // And through the route, which once flattened every import failure to a 400.
    await assert.rejects(
      () => callRoute(archiveRoutes, "/api/archive/import", { method: "POST", raw: zip }),
      (err: Error) => {
        const status = handlerErrorStatus(err);
        assert.equal(status, 409);
        assert.equal(handlerErrorCode(err, status), "unsaved");
        assert.match(err.message, new RegExp(key1.replace(/[^A-Za-z0-9]/g, ".")));
        return true;
      },
    );
    for (const { name, rec } of RECORDERS) {
      assert.ok((await rec.getRecord(key1))?.endedAt, `${name}: lost the held copy`);
    }
  });

  /** Run `during` once, inside the timeline recorder's next resumeRecord: the
   *  await between taking a record and adopting it. Once only, so the tick
   *  after reads the store for real. */
  function duringNextResume(t: TestContext, during: () => Promise<void> | void): void {
    const rec = serviceTimelineRecorder as unknown as { resumeRecord(r: unknown): Promise<unknown> };
    const real = rec.resumeRecord.bind(rec);
    let fired = false;
    t.mock.method(rec, "resumeRecord", async (r: unknown) => {
      if (!fired) {
        fired = true;
        await during();
      }
      return real(r);
    });
  }

  it("reads the store again when a held copy is forgotten while it is being resumed", async (t) => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await setWritable(false);
    await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome");
    await setWritable(true);

    duringNextResume(t, () => void serviceTimelineRecorder.forget(key1));
    await tick("2026-10-18T18:10:00.000Z", "occ-a", "doors");
    assert.equal(serviceTimelineRecorder.getCurrent(), null, "adopted a record forgotten mid-resume");
    // The held copy never reached disk, so the next tick starts afresh.
    await tick("2026-10-18T18:10:01.000Z", "occ-a", "doors");
    const current = serviceTimelineRecorder.getCurrent();
    assert.equal(current?.serviceKey, key1);
    assert.equal(current?.startedAt, "2026-10-18T18:10:01.000Z", "resumed a held copy that was forgotten");
  });

  it("starts afresh when a saved record is deleted while it is being resumed", async (t) => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome"); // occ-a saved, not held
    assert.equal(serviceTimelineRecorder.isHolding(key1), false);
    assert.ok((await readRecord("service-timeline", key1))?.endedAt, "occ-a never reached disk");

    // What deleteServiceRecords does to this recorder (forget, then the store
    // delete). Called directly because the other two recorders, ticking
    // alongside, may already have re-established occ-a, and the real delete
    // then refuses a live service.
    duringNextResume(t, async () => {
      serviceTimelineRecorder.forget(key1);
      await serviceTimelineStore.delete(key1);
    });
    await tick("2026-10-18T18:10:00.000Z", "occ-a", "doors");
    await tick("2026-10-18T18:10:01.000Z", "occ-a", "doors");
    const current = serviceTimelineRecorder.getCurrent();
    assert.equal(current?.serviceKey, key1);
    assert.equal(current?.startedAt, "2026-10-18T18:10:01.000Z", "resumed a record deleted in History meanwhile");
  });

  it("resumes the edited record when an edit lands while it is being resumed", async (t) => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome"); // occ-a saved, not held
    const saved = (await serviceTimelineStore.get(key1))!;

    // What editServiceWindow does to this recorder (forget, then the store
    // write), directly for the reason the delete test gives.
    const edited = { ...saved, startedAt: "2026-10-18T14:05:00.000Z" };
    duringNextResume(t, async () => {
      serviceTimelineRecorder.forget(key1);
      await serviceTimelineStore.upsert(edited);
    });
    await tick("2026-10-18T18:10:00.000Z", "occ-a", "doors");
    await tick("2026-10-18T18:10:01.000Z", "occ-a", "doors");
    assert.equal(
      serviceTimelineRecorder.getCurrent()?.startedAt,
      "2026-10-18T14:05:00.000Z",
      "did not resume the record as History edited it",
    );
    // And no persist writes anything but the edited record back.
    mock.timers.tick(PAST_EVERY_RETRY_MS);
    await drainStores();
    assert.equal((await readRecord("service-timeline", key1))?.startedAt, "2026-10-18T14:05:00.000Z");
  });

  it("resumes a held copy whose retried save lands while it is being resumed", async () => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    await setWritable(false);
    await tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome");
    await setWritable(true);

    // The retry timer fires during resumeRecord (SPL's reads the whole raw
    // archive) and its save succeeds, which takes the copy out of `unsaved`
    // just as a forget would.
    const rec = serviceTimelineRecorder as unknown as { resumeRecord(r: unknown): Promise<unknown> };
    mock.method(rec, "resumeRecord", async (r: unknown) => {
      await runRetries(async () => !serviceTimelineRecorder.isHolding(key1));
      return r;
    });
    await tick("2026-10-18T18:10:00.000Z", "occ-a", "doors");
    assert.equal(
      serviceTimelineRecorder.getCurrent()?.startedAt,
      "2026-10-18T14:00:00.000Z",
      "read a successful retry as a forget and opened a fresh record",
    );

    // And the debounced persist does not write a fresh record over the saved one.
    mock.timers.tick(PAST_EVERY_RETRY_MS);
    await drainStores();
    assert.equal((await readRecord("service-timeline", key1))?.startedAt, "2026-10-18T14:00:00.000Z");
  });

  it("does not hold a record forgotten while its failing save was out", async (t) => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");

    // The save of the outgoing record waits until released, then fails.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const realUpsert = serviceTimelineStore.upsert.bind(serviceTimelineStore);
    t.mock.method(serviceTimelineStore, "upsert", async (r: { serviceKey: string }) => {
      if (r.serviceKey !== key1) return realUpsert(r as never);
      await released;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });

    const splitting = tick("2026-10-18T16:05:00.000Z", "occ-b", "welcome");
    await settle();
    serviceTimelineRecorder.forget(key1); // the operator deletes it meanwhile
    release();
    await splitting;

    assert.equal(serviceTimelineRecorder.isHolding(key1), false, "held a forgotten record for retry");
    assert.ok(errors.some((e) => e.includes("changed in History meanwhile; not retried")));
  });

  it("refuses an edit when the service becomes held during the edit's own checks", async (t) => {
    const key1 = `75953:${planId}:occ-a`;
    await tick("2026-10-18T14:00:00.000Z", "occ-a", "doors");
    mock.timers.setTime(Date.parse("2026-10-18T14:30:00.000Z")); // no longer live

    // A split, with the folders read-only, lands inside assertEditable's awaits.
    const realAssert = splHistoryStore.assertReadable.bind(splHistoryStore);
    let fired = false;
    t.mock.method(splHistoryStore, "assertReadable", async (k: string) => {
      if (!fired) {
        fired = true;
        await setWritable(false);
        await tick("2026-10-18T14:30:00.000Z", "occ-b", "welcome");
        await setWritable(true);
      }
      return realAssert(k);
    });

    await assert.rejects(
      () => editServiceWindow(key1, { endedAt: "2026-10-18T14:20:00.000Z" }),
      (err: Error & { code?: string }) => err.code === "unsaved",
    );
    for (const { name, rec } of RECORDERS) assert.ok(rec.isHolding(key1), `${name}: dropped the held copy`);
  });
});
