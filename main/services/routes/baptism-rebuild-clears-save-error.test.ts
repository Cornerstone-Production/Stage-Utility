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
});
