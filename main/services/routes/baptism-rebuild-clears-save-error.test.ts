// baptism-rebuild-clears-save-error.test.ts — a rebuild that restores a
// session Finish could not save clears that entry too, on the server, and
// the push carries it — whichever route actually restored it.
//
// The save failure itself is REAL: addSession is stubbed to reject for one
// Finish, exactly the way baptism-save-error.test.ts drives it (open service,
// real timer, real raw rows), so the entry this proves clearing is the one an
// operator would actually see. The rebuild that clears it goes through the
// real POST routes — never a stub of applyBaptismRebuild or mergeRebuilt.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-rebuild-clears-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./history-routes.js");
const { callRoute } = await import("./route-harness.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { baptismStore } = await import("../baptism-store.js");
const { baptismTimerService: timer } = await import("../baptism-timer-service.js");
const { sampleArchive } = await import("../archive/sample-archive.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { baptismSessionId } = await import("../../types/stage.js");

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };
const rec = () => serviceTimelineRecorder as unknown as Held;

const pushes: BaptismState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "baptism:state") pushes.push(payload as BaptismState);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first push after index `from` that satisfies `test` — polled, like
 *  baptism-save-error.test.ts's own helper, since the save settles on the
 *  store's write queue rather than after a fixed delay. */
async function pushWhere(from: number, test: (s: BaptismState) => boolean, what: string): Promise<BaptismState> {
  for (let i = 0; i < 200; i++) {
    const hit = pushes.slice(from).find(test);
    if (hit) return hit;
    await sleep(5);
  }
  const seen = pushes.slice(from).map((s) => ({ phase: s.phase, saveErrors: s.saveErrors }));
  assert.fail(`no push ${what} within 1s; pushes since: ${JSON.stringify(seen)}`);
}

type AddSession = typeof baptismStore.addSession;
function stubAddSession(impl: AddSession): () => void {
  const store = baptismStore as unknown as { addSession: AddSession };
  const original = store.addSession;
  store.addSession = impl;
  return () => {
    store.addSession = original;
  };
}
const FS_ERROR: unknown = Object.assign(new Error("ENOSPC: no space left on device"), { errno: -28 });
const rejecting: AddSession = async () => {
  throw FS_ERROR;
};

const DATE = "2026-09-20";
function timeline(serviceKey: string) {
  return {
    serviceKey,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Sunday Gathering",
    seriesTitle: null,
    serviceDate: DATE,
    serviceTimeId: "t-1",
    serviceTimeStartsAt: null,
    startedAt: `${DATE}T09:00:00.000Z`,
    endedAt: `${DATE}T10:30:00.000Z`,
    items: [],
  };
}

/**
 * Drive one grouped session to Finish with addSession stubbed to reject — a
 * REAL failed save, raw rows and all: an open service is set on the recorder
 * first, so emitRaw's own gate ("Open" mirrors currentServiceKey's meaning —
 * a record exists and endedAt == null) lets it actually write
 * `start`/`testimony-end`/`finish` rows to that service's baptism.csv.
 * Returns the failed session's own id.
 *
 * Deliberately does NOT reset() the timer — reset() clears saveErrors along
 * with everything else (see idleState), so a test proving TWO failures both
 * survive (one restored, the other untouched) has to drive them back to back
 * exactly the way baptism-save-error.test.ts's own "two sessions fail" test
 * does: start() again straight from the idle phase Finish just returned to.
 */
async function realFailedSave(serviceKey: string): Promise<string> {
  rec().current = { serviceKey, serviceDate: DATE, endedAt: null };
  const restore = stubAddSession(rejecting);
  let sessionId!: string;
  try {
    const mark = pushes.length;
    const started = timer.start();
    assert.equal(started.phase, "testimony", `sanity: start() actually started a session for ${serviceKey}`);
    await sleep(5);
    const finished = timer.finish();
    assert.equal(finished.phase, "idle", "sanity: the session finished");
    assert.equal(finished.people.length, 1, "sanity: there is a session to save");
    sessionId = baptismSessionId(timer.getState().sessionStartedAt!);
    await pushWhere(mark, (s) => !!s.saveErrors?.length, `carrying a saveErrors entry for ${serviceKey}`);
  } finally {
    restore();
  }
  rec().current = null;
  return sessionId;
}

/** Poll listSessions() until `id` actually lands — a successful save is a
 *  fire-and-forget promise inside finalize(), never awaited by finish()
 *  itself, and (unlike a FAILED save) a clean first-time save pushes
 *  NOTHING: finalize()'s own success callback only commits when it actually
 *  clears a PRIOR saveErrors entry, which a session's first Finish has
 *  none of. */
async function waitForStored(id: string, timeoutMs = 3000): Promise<BaptismSession> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = (await baptismStore.listSessions()).find((s) => s.id === id);
    if (found) return found;
    await sleep(10);
  }
  throw new Error(`session ${id} never landed in baptism.json`);
}

/**
 * Drive a session to a REAL successful Finish, then Undo it and re-Finish
 * later with addSession stubbed to reject — a real failed save of a
 * RE-Finish, on a session the store already has a (now-stale) copy of. The
 * store's own entry is never touched by the failed second save, so a rebuild
 * of this service can only UPDATE it (planBaptismRebuild's own rule: a
 * genuinely later Finish than what the store holds), never add it — this is
 * exactly the shape addedIds alone cannot clear. Returns the session's own
 * id and its two finishedAt stamps.
 */
async function realFailedReFinish(serviceKey: string): Promise<{ id: string; firstFinishedAt: string; secondFinishedAt: string }> {
  rec().current = { serviceKey, serviceDate: DATE, endedAt: null };
  const started = timer.start();
  assert.equal(started.phase, "testimony", `sanity: start() actually started a session for ${serviceKey}`);
  await sleep(5);
  const first = timer.finish(); // REAL save — addSession is not stubbed here
  assert.equal(first.phase, "idle", "sanity: the session finished the first time");
  const id = baptismSessionId(timer.getState().sessionStartedAt!);
  await waitForStored(id); // sanity: the first Finish actually saved
  const firstFinishedAt = first.finishedAt!;

  const reopened = timer.undo();
  assert.equal(reopened.finishedAt, null, "sanity: Undo reopened the session");
  // Well past BAPTISM_FINISH_TIE_MS (100ms) and past the ~12ms clock-skew
  // ceiling measured elsewhere — this must read as a GENUINELY later Finish,
  // never "the same one" within the tie band.
  await sleep(300);

  const restore = stubAddSession(rejecting);
  let secondFinishedAt!: string;
  try {
    const mark = pushes.length;
    const second = timer.finish();
    assert.equal(second.phase, "idle", "sanity: the session finished the second time");
    secondFinishedAt = second.finishedAt!;
    assert.notEqual(secondFinishedAt, firstFinishedAt, "sanity: the re-Finish has its own, later timestamp");
    await pushWhere(mark, (s) => !!s.saveErrors?.length, `carrying a saveErrors entry for the re-Finish of ${serviceKey}`);
  } finally {
    restore();
  }
  rec().current = null;
  return { id, firstFinishedAt, secondFinishedAt };
}

type RecordBaptism = typeof sampleArchive.recordBaptism;

/**
 * Drive a grouped session through Start → armed → the first person in, then
 * Finish with BOTH addSession stubbed to reject AND the finish row's own CSV
 * append suppressed — the shape a full or read-only disk actually produces,
 * not merely the shape this file's other helpers exercise. `csv-appender`
 * logs and discards a failed append the same way finalize()'s own failed
 * save is caught (see baptism-timer-service.ts's persist/session-save
 * catches): a disk that is out of room when Finish fires drops BOTH writes
 * at once, so the raw rows can hold every press up to Finish and nothing
 * that closes it — start, baptisms-armed, baptisms-start, no finish.
 * Returns the session's own id.
 */
async function realNeverFinishedSave(serviceKey: string): Promise<string> {
  timer.setMode("grouped"); // startBaptisms() below is a no-op outside grouped mode
  rec().current = { serviceKey, serviceDate: DATE, endedAt: null };
  const restoreSave = stubAddSession(rejecting);
  const archive = sampleArchive as unknown as { recordBaptism: RecordBaptism };
  const originalRecord = archive.recordBaptism.bind(sampleArchive);
  archive.recordBaptism = (ctx, fields, at) => {
    if (fields.event === "finish") return; // the row a full/read-only disk drops too
    originalRecord(ctx, fields, at);
  };
  let sessionId!: string;
  try {
    const mark = pushes.length;
    const started = timer.start();
    assert.equal(started.phase, "testimony", `sanity: start() actually started a session for ${serviceKey}`);
    await sleep(5);
    const armed = timer.startBaptisms();
    assert.equal(armed.armed, true, "sanity: startBaptisms armed the grouped baptism section");
    await sleep(5);
    const running = timer.advance();
    assert.equal(running.armed, false, "sanity: advance() started the first person's own clock");
    await sleep(5);
    const finished = timer.finish();
    assert.equal(finished.phase, "idle", "sanity: Finish still closes the session, whatever its own writes did");
    sessionId = baptismSessionId(timer.getState().sessionStartedAt!);
    await pushWhere(mark, (s) => !!s.saveErrors?.length, `carrying a saveErrors entry for ${serviceKey}`);
  } finally {
    archive.recordBaptism = originalRecord;
    restoreSave();
  }
  // sampleArchive's own CSV appends are fire-and-forget too — flush before a
  // caller reads baptism.csv back, the same reason rebuild-baptism-
  // roundtrip.test.ts's own realistic-clock tests flush before asserting.
  await sampleArchive.flush();
  rec().current = null;
  return sessionId;
}

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("a rebuild that restores a save-failed session clears its note entry", () => {
  // A FRESH, never-reused key per test — sampleArchive caches a CsvAppender
  // per serviceKey for the life of this process (see sample-archive.ts's own
  // `entry()`), so a key driven through the real timer in one test and then
  // rebuilt in another would find that appender still believing its old
  // `baptism.csv` exists after this file's own beforeEach deletes the
  // directory underneath it, and skip recreating it on the next write —
  // ENOENT for a reason that has nothing to do with the behaviour under
  // test. Distinct keys per test sidestep the cache entirely.
  async function prepare(key: string): Promise<void> {
    serviceTimelineRecorder.forget(key);
    await serviceTimelineStore.upsert(timeline(key) as never);
    for (const s of (await baptismStore.listSessions()).filter((s) => s.serviceKey === key)) {
      await baptismStore.deleteSession(s.id);
    }
    timer.reset();
  }

  it("POST /api/baptism/rebuild restores the session, clears exactly its own entry, and pushes the change — an unrelated entry stays", async () => {
    const KEY_A = "st1:plan-1:bap-clears-a1";
    const KEY_B = "st1:plan-1:bap-clears-b1";
    await prepare(KEY_A);
    await prepare(KEY_B);
    const idA = await realFailedSave(KEY_A);
    const idB = await realFailedSave(KEY_B);
    assert.ok(timer.getState().saveErrors?.some((e) => e.sessionId === idA), "sanity: A's note is up");
    assert.ok(timer.getState().saveErrors?.some((e) => e.sessionId === idB), "sanity: B's note is up");

    const mark = pushes.length;
    const out = await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY_A } });
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    const json = out.json as { added: number };
    assert.equal(json.added, 1, "A's failed session had no stored counterpart at all, so the rebuild must ADD it");

    const stored = await baptismStore.listSessions();
    assert.ok(stored.some((s) => s.id === idA), "the rebuild must actually restore A's session");

    await pushWhere(mark, (s) => !s.saveErrors?.some((e) => e.sessionId === idA), "clearing A's restored entry");
    const after = timer.getState();
    assert.equal(
      after.saveErrors?.some((e) => e.sessionId === idA),
      false,
      "A's entry must be gone from the timer's own state too, not just one push",
    );
    assert.equal(
      after.saveErrors?.some((e) => e.sessionId === idB),
      true,
      "rebuilding A's service must never touch B's unrelated entry",
    );
  });

  it("POST /api/history/rebuild (the whole-service rebuild) clears it too, not only the baptism-only route", async () => {
    const KEY_C = "st1:plan-1:bap-clears-c2";
    await prepare(KEY_C);
    // planBaptismRebuild matches against EVERY stored session, not only this
    // service's (see its own doc comment), falling back to the nearest one
    // within BAPTISM_SKEW_MS (2000ms) of a rebuilt session's own startedAt
    // when no id matches exactly. The previous test's session A is still in
    // the store (this test only rebuilds C's own key, not A's), so without
    // real separation C's own startedAt could fall inside that 2s window of
    // A's and get cross-matched against an unrelated service's session —
    // which is a real rule for two genuinely close recordings, not a defect
    // this test should be exercising.
    await sleep(2100);
    const idC = await realFailedSave(KEY_C);

    const mark = pushes.length;
    const out = await callRoute(historyRoutes, "/api/history/rebuild", { method: "POST", body: { serviceKey: KEY_C } });
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);

    await pushWhere(mark, (s) => !s.saveErrors?.some((e) => e.sessionId === idC), "clearing via the whole-service rebuild");
    assert.equal(
      timer.getState().saveErrors?.some((e) => e.sessionId === idC),
      false,
      "the whole-service rebuild must clear the same entry the baptism-only route does",
    );
  });

  // The session already has a stored counterpart (the first Finish saved
  // fine) — a rebuild can only UPDATE it, never add it. addedIds alone
  // cannot see this: mergeRebuilt must report which ids it actually wrote a
  // REPLACEMENT for, at write time, the same way it already does for adds.
  it("a re-Finish's failed save clears too, once the rebuild UPDATES the stored session to match it", async () => {
    const KEY_D = "st1:plan-1:bap-clears-d3";
    await prepare(KEY_D);
    await sleep(2100); // stay outside BAPTISM_SKEW_MS of any earlier test's session
    const { id, firstFinishedAt, secondFinishedAt } = await realFailedReFinish(KEY_D);

    // The store still holds the FIRST Finish — the second, later one never
    // landed — so the note is up while the store is stale.
    const before = await baptismStore.listSessions();
    const beforeStored = before.find((s) => s.id === id);
    assert.equal(beforeStored?.finishedAt, firstFinishedAt, "sanity: the store still holds the stale, first Finish");
    assert.ok(timer.getState().saveErrors?.some((e) => e.sessionId === id), "sanity: the re-Finish's note is up");

    const mark = pushes.length;
    const out = await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY_D } });
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    const json = out.json as { added: number; updated: number };
    assert.equal(json.added, 0, "the session already had a stored counterpart — this must not be reported as added");
    assert.equal(json.updated, 1, "the rebuild must UPDATE the existing session, not add a second one");

    const after = await baptismStore.listSessions();
    const afterStored = after.find((s) => s.id === id);
    assert.equal(afterStored?.finishedAt, secondFinishedAt, "the store must now hold the LATER Finish the raw rows show");
    assert.equal((after.filter((s) => s.id === id)).length, 1, "still exactly one session under this id — never a duplicate");

    await pushWhere(mark, (s) => !s.saveErrors?.some((e) => e.sessionId === id), "clearing the re-Finish's own entry");
    assert.equal(
      timer.getState().saveErrors?.some((e) => e.sessionId === id),
      false,
      "the entry must clear once the rebuild's UPDATE lands, not only for an ADD",
    );
  });

  // A full or read-only disk drops the finish row too, not only the JSON
  // save — the raw rows hold every press up to Finish and nothing that
  // closes it, so a rebuild has no finished copy of this session to
  // restore. It must say so rather than reporting success having written
  // nothing, and the note must stay up rather than reading as resolved.
  it("a rebuild reports it restored nothing when the raw rows themselves never reached a finish, and the entry stays", async () => {
    const KEY_E = "st1:plan-1:bap-clears-e4";
    await prepare(KEY_E);
    await sleep(2100); // stay outside BAPTISM_SKEW_MS of any earlier test's session
    const idE = await realNeverFinishedSave(KEY_E);
    assert.ok(timer.getState().saveErrors?.some((e) => e.sessionId === idE), "sanity: E's note is up");

    const out = await callRoute(historyRoutes, "/api/baptism/rebuild", { method: "POST", body: { serviceKey: KEY_E } });
    assert.equal(out.status, 200, `expected 200, got ${out.status}: ${out.body}`);
    const json = out.json as { added: number; updated: number; restoredIds: unknown };
    assert.equal(json.added, 0, "there is no finished copy in the raw rows at all — nothing to add");
    assert.equal(json.updated, 0, "nor anything to update");
    assert.ok(Array.isArray(json.restoredIds), `expected the response to carry restoredIds, got ${JSON.stringify(json)}`);
    assert.ok(
      !(json.restoredIds as string[]).includes(idE),
      `expected restoredIds to exclude the never-finished session, got ${JSON.stringify(json.restoredIds)}`,
    );

    // Never cleared: nothing was actually restored for this id.
    await sleep(200);
    assert.equal(
      timer.getState().saveErrors?.some((e) => e.sessionId === idE),
      true,
      "a rebuild that restored nothing for this session must leave its own note exactly as it was",
    );
  });
});
