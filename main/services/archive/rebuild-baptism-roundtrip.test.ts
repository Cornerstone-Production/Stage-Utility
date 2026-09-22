// rebuild-baptism-roundtrip.test.ts — the guard that matters for the replay.
//
// Hand-written fixture rows (rebuild-baptism.test.ts) can only assert what
// their author believed the emitter writes, and this repo has been bitten
// repeatedly by green tests over pieces with a broken path through them. So
// every test here drives the REAL baptismTimerService against a real temp data
// dir, lets the REAL sampleArchive write real rows, reads them back with the
// REAL readBaptismRows, replays them, and asserts the result is the session
// baptismStore.listSessions() actually holds.
//
// That closes the loop end to end, and it is also the completeness guard for
// the emit calls themselves: delete any one emitRaw in baptism-timer-service.ts
// and a scenario here reconstructs the wrong people.
//
// WHAT IS COMPARED, AND THE ONE THING THAT IS NOT
//
// `people`, `serviceKey`, `title`, `serviceTypeId` and `planId` are compared
// exactly. `startedAt`, `finishedAt` and the `id` derived from `startedAt` are
// compared within a tolerance, because they CANNOT be reconstructed exactly:
// the timer stamps its own state (`new Date().toISOString()` in start() and
// finalize()) a moment before handing the row to emitRaw, and recordBaptism
// stamps the row itself. The replay only has the row's stamp, so it runs a
// millisecond or two late. See the header of rebuild-baptism.ts. The splits —
// which is what this feature exists to record — come back exactly.
//
// Each `it` uses its OWN serviceKey, for the same reason baptism-timer-raw.
// test.ts does: the archive is an append-only CSV keyed by serviceKey and the
// singleton sampleArchive never resets between tests in one file.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-replay-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("../baptism-timer-service.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { stageController } = await import("../stage-controller.js");
const { sampleArchive } = await import("./sample-archive.js");
const { rebuildBaptismSessions, readBaptismRows } = await import("./rebuild-baptism.js");

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };
const rec = () => serviceTimelineRecorder as unknown as Held;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let ctxCounter = 0;
function freshCtx() {
  ctxCounter += 1;
  return { serviceKey: `st1:plan1:replay${ctxCounter}`, serviceDate: "2026-09-20" };
}

function openService(ctx: { serviceKey: string; serviceDate: string }): void {
  rec().current = { ...ctx, endedAt: null };
}

/** The session the store holds for this service, once the fire-and-forget save
 *  behind finalize() has settled. Polled rather than slept on: the save is a
 *  queued read-modify-write, not a fixed delay. */
async function storedSession(ctx: { serviceKey: string }) {
  for (let i = 0; i < 200; i++) {
    const found = (await baptismTimerService.listSessions()).filter((s) => s.serviceKey === ctx.serviceKey);
    if (found.length > 0) return found;
    await sleep(5);
  }
  throw new Error(`no stored session for ${ctx.serviceKey} after 1s`);
}

/**
 * Replay this service's real archived rows and assert they reproduce the
 * sessions the store recorded.
 *
 * Returns the replayed sessions so a scenario can make its own extra claims.
 */
async function assertRoundTrip(ctx: { serviceKey: string; serviceDate: string }, why: string) {
  await sampleArchive.flush();
  const stored = await storedSession(ctx);

  const rows = await readBaptismRows(ctx.serviceKey, ctx.serviceDate);
  assert.ok(rows, `${why}: readBaptismRows found an archive for this service`);
  assert.ok(rows!.length > 0, `${why}: the archive holds rows`);

  // Identity is derived the way start() derives it, not copied off the stored
  // session — copying it would make these fields assert nothing.
  const st = stageController.getState();
  const replayed = rebuildBaptismSessions(rows!, {
    serviceKey: ctx.serviceKey,
    title: st.planTitle ?? null,
    serviceTypeId: st.serviceTypeId ?? null,
    planId: st.planId ?? null,
  });

  // listSessions() is newest-first; the replay is chronological.
  const expected = [...stored].reverse();
  assert.equal(replayed.length, expected.length, `${why}: one replayed session per stored session`);

  replayed.forEach((got, i) => {
    const want = expected[i]!;
    assert.deepEqual(got.people, want.people, `${why}: every person's splits, exactly`);
    assert.equal(got.serviceKey, want.serviceKey, `${why}: serviceKey`);
    assert.equal(got.title, want.title, `${why}: title`);
    assert.equal(got.serviceTypeId, want.serviceTypeId, `${why}: serviceTypeId`);
    assert.equal(got.planId, want.planId, `${why}: planId`);

    // The archive stamps each row itself, a beat after the timer stamped its
    // own state — see this file's header. Bounded, never exact.
    const startDrift = Date.parse(got.startedAt) - Date.parse(want.startedAt);
    const finishDrift = Date.parse(got.finishedAt) - Date.parse(want.finishedAt);
    assert.ok(
      startDrift >= 0 && startDrift < 100,
      `${why}: startedAt is the archive's stamp, at or just after the timer's (drift ${startDrift}ms)`,
    );
    assert.ok(
      finishDrift >= 0 && finishDrift < 100,
      `${why}: finishedAt is the archive's stamp, at or just after the timer's (drift ${finishDrift}ms)`,
    );
    assert.equal(got.id, `bap-${Date.parse(got.startedAt)}`, `${why}: the id follows its own startedAt`);
  });

  return replayed;
}

describe("a real grouped session replays back into the session the store recorded", () => {
  it("run to its natural end, where the last person auto-finishes", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next(); // person 1's testimony ends
    await sleep(8);
    baptismTimerService.startBaptisms(); // person 2's testimony folds in, section arms
    baptismTimerService.advance(); // first person in
    await sleep(8);
    baptismTimerService.next(); // person 1 baptized
    await sleep(12);
    const finished = baptismTimerService.next(); // person 2 (last) — auto-finishes

    assert.equal(finished.phase, "idle");
    assert.equal(finished.people.length, 2);
    assert.ok(finished.people[0]!.baptizeMs > 0 && finished.people[1]!.baptizeMs > 0);

    const [replayed] = await assertRoundTrip(ctx, "grouped, natural end");
    assert.equal(replayed!.people.length, 2);
  });

  it("finished mid-baptism, with the second person never baptized", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    baptismTimerService.startBaptisms();
    baptismTimerService.advance();
    await sleep(8);
    const finished = baptismTimerService.finish(); // closes person 1, person 2 never baptized

    assert.equal(finished.people.length, 2);
    assert.ok(finished.people[0]!.baptizeMs > 0);
    assert.equal(finished.people[1]!.baptizeMs, 0);

    const [replayed] = await assertRoundTrip(ctx, "grouped, finished mid-baptism");
    assert.equal(replayed!.people[1]!.baptizeMs, 0, "an unbaptized person replays as unbaptized, not as missing");
  });

  it("finished during the testimony section, the baptisms cancelled", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    const finished = baptismTimerService.finish(); // Finish instead of Start Baptisms

    assert.equal(finished.people.length, 2);
    assert.ok(finished.people[1]!.testimonyMs > 0);

    const [replayed] = await assertRoundTrip(ctx, "grouped, finished in the testimonies");
    assert.equal(replayed!.people.length, 2);
  });

  it("finished while still armed, before anyone stepped up", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    baptismTimerService.startBaptisms();
    const finished = baptismTimerService.finish(); // no person-complete row exists for either

    assert.equal(finished.people.length, 2);
    assert.equal(finished.people[0]!.baptizeMs, 0);
    assert.equal(finished.people[1]!.baptizeMs, 0);

    await assertRoundTrip(ctx, "grouped, finished while armed");
  });
});

describe("a real per-person session replays back into the session the store recorded", () => {
  it("two people, closed by the Finish press that is its only terminator", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.baptized();
    await sleep(8);
    baptismTimerService.next(); // person 1 done, person 2's testimony starts
    await sleep(8);
    baptismTimerService.baptized();
    await sleep(12);
    const finished = baptismTimerService.finish();

    assert.equal(finished.people.length, 2);
    assert.ok(finished.people.every((p) => p.testimonyMs > 0 && p.baptizeMs > 0));

    const [replayed] = await assertRoundTrip(ctx, "per-person, two people");
    assert.equal(replayed!.people.length, 2);
  });

  it("one person whose testimony Finish closed before any baptism", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");

    baptismTimerService.start();
    await sleep(8);
    const finished = baptismTimerService.finish();

    assert.equal(finished.people.length, 1);
    assert.equal(finished.people[0]!.baptizeMs, 0);

    await assertRoundTrip(ctx, "per-person, finished in the testimony");
  });
});

describe("a real session containing an undo replays back into the session the store recorded", () => {
  it("re-baptizing the same person keeps the second attempt, not the first", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    baptismTimerService.startBaptisms();
    baptismTimerService.advance();
    await sleep(8);
    baptismTimerService.next(); // person 1 baptized — a mis-tap, too early
    baptismTimerService.undo(); // back to person 1
    await sleep(40); // the real baptism runs measurably longer
    baptismTimerService.next(); // person 1 baptized for real
    await sleep(8);
    const finished = baptismTimerService.next(); // person 2 — auto-finishes

    assert.equal(finished.people.length, 2);

    const [replayed] = await assertRoundTrip(ctx, "grouped, undo and re-baptize");
    assert.equal(
      replayed!.people.length,
      2,
      "three person-complete rows describe two people — counting rows would report three",
    );
    assert.ok(
      replayed!.people[0]!.baptizeMs >= 40,
      `the second attempt's time survived the replay (got ${replayed!.people[0]!.baptizeMs}ms, ` +
        "which is the first, undone attempt)",
    );
  });

  it("correcting the SECOND of three people leaves the first one's baptism alone", async () => {
    // Every other undo in this file steps back at baptismIndex 0, where the
    // row's index and a hardcoded 0 are the same number. Replacing the replay's
    // `num(r.baptismIndex)` with `0` left the committed suite green while
    // zeroing person 0's baptism on any service where the operator corrected
    // somebody further down the line — which is the ordinary case, not the edge
    // one.
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(12);
    baptismTimerService.next(); // person 1's testimony ends
    await sleep(12);
    baptismTimerService.next(); // person 2's testimony ends
    await sleep(11);
    baptismTimerService.startBaptisms(); // person 3 folds in, section arms
    baptismTimerService.advance();
    await sleep(12);
    baptismTimerService.next(); // index 0 baptized
    await sleep(12);
    baptismTimerService.next(); // index 1 baptized — a beat early
    baptismTimerService.undo(); // back to index 1, NOT index 0
    await sleep(42); // the real baptism, measurably longer
    baptismTimerService.next(); // index 1 baptized for real
    await sleep(11);
    const finished = baptismTimerService.next(); // index 2 (last) — auto-finishes

    assert.equal(finished.people.length, 3);
    assert.ok(finished.people[0]!.baptizeMs > 0, "sanity: person 0 was baptized and kept their time");

    const [replayed] = await assertRoundTrip(ctx, "grouped, undo at index 1 of three");
    assert.ok(
      replayed!.people[0]!.baptizeMs > 0,
      `person 0's baptism must survive an undo aimed at person 1 (got ${replayed!.people[0]!.baptizeMs}ms)`,
    );
    assert.ok(
      replayed!.people[1]!.baptizeMs >= 42,
      "person 1 carries the corrected attempt, not the one that was undone",
    );
  });

  it("armed on the wrong song, undone, re-armed — still one person", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start(); // the only person
    await sleep(40);
    baptismTimerService.startBaptisms(); // wrong song
    baptismTimerService.undo(); // back into the testimony section
    await sleep(20);
    baptismTimerService.startBaptisms(); // right song
    const finished = baptismTimerService.finish();

    assert.equal(finished.people.length, 1, "sanity: a one-person service finished as one person");

    const [replayed] = await assertRoundTrip(ctx, "grouped, arm/undo/re-arm");
    assert.equal(
      replayed!.people.length,
      1,
      "two baptisms-armed rows describe ONE person — without the undo pop this replays as two",
    );
    assert.ok(
      replayed!.people[0]!.testimonyMs >= 40,
      "the re-arm's resumed testimony, not just the gap after the undo",
    );
  });

  it("per-person Baptized pressed early, undone, then pressed again", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");

    baptismTimerService.start();
    await sleep(40);
    baptismTimerService.baptized(); // a beat early
    baptismTimerService.undo(); // back into the testimony
    await sleep(20);
    baptismTimerService.baptized();
    await sleep(8);
    const finished = baptismTimerService.finish();

    assert.equal(finished.people.length, 1);

    const [replayed] = await assertRoundTrip(ctx, "per-person, undo out of the baptism");
    assert.equal(
      replayed!.people.length,
      1,
      "the undo pops NOBODY in per-person mode, however much it looks like the grouped row that does",
    );
  });
});

describe("a service with no baptism archive has nothing to rebuild from", () => {
  it("readBaptismRows returns null, the same contract rebuildSplItems has", async () => {
    assert.equal(await readBaptismRows("st1:plan1:never-recorded", "2026-09-20"), null);
  });
});
