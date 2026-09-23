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
// WHAT IS COMPARED
//
// Everything, exactly: `people`, `serviceKey`, `title`, `serviceTypeId`,
// `planId`, `startedAt`, `finishedAt` and the `id` derived from `startedAt`.
// `start()` and `finalize()` pass their own `now`/`finishedAt` through emitRaw
// to recordBaptism, which stamps the `start` and `finish` rows with that exact
// string instead of reading its own clock — see recordBaptism and the header of
// rebuild-baptism.ts. Before that threading existed the two stamps were
// separate reads of the clock a moment apart, and the ticking-clock tests below
// reproduce that drift deterministically rather than at the ~4% rate it was
// measured at.
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
const { stageController } = await import("../stage-controller.js");
const { sampleArchive } = await import("./sample-archive.js");
const { rebuildBaptismSessions, readBaptismRows } = await import("./rebuild-baptism.js");
// Opening a service, a fresh key per test, and waiting on the store: shared with
// baptism-lane-roundtrip.test.ts, so the two guards cannot drift apart.
const { freshCtx, openService, sleep, storedSessions } = await import("./baptism-roundtrip-harness.js");

/**
 * Replay this service's real archived rows and assert they reproduce the
 * sessions the store recorded.
 *
 * Returns the replayed sessions so a scenario can make its own extra claims.
 */
async function assertRoundTrip(ctx: { serviceKey: string; serviceDate: string }, why: string) {
  await sampleArchive.flush();
  const stored = await storedSessions(ctx);

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

    // The `start`/`finish` rows carry the timer's OWN stamp now (see this
    // file's header), so these match exactly rather than within a bound.
    assert.equal(got.startedAt, want.startedAt, `${why}: startedAt matches the stored session exactly`);
    assert.equal(got.finishedAt, want.finishedAt, `${why}: finishedAt matches the stored session exactly`);
    assert.equal(got.id, want.id, `${why}: the rebuilt id is the id the store saved the session under`);
  });

  return replayed;
}

/**
 * Swap the global `Date` for one whose every read — `new Date()` with no
 * arguments, or `Date.now()` — hands back a NEW, strictly later instant, so two
 * reads a moment apart in the same synchronous call can never land on the same
 * millisecond. On a real clock this drift only shows on about one session in
 * twenty; forcing every read strictly later reproduces it on EVERY run instead:
 * on today's code, start()'s own stamp and the row's stamp (recordBaptism's own
 * `new Date()`) are two separate reads of this clock, so they now differ every
 * time instead of one session in twenty.
 *
 * `Date.parse` and `Date.UTC` are copied from the real `Date` unchanged —
 * segmentElapsedMs calls `Date.parse` while this is installed (baptized(),
 * next() and finish() all read elapsed time), and it must parse the real ISO
 * strings this clock still produces rather than losing the method entirely.
 *
 * Restore with the returned function. Every call site below does so in a
 * `finally`, so a failing assertion mid-drive cannot leave the fake clock
 * running under whatever `it` node:test schedules next in this file.
 */
function installEverTickingClock(): () => void {
  const RealDate = globalThis.Date;
  let ticks = 0;
  const nextMs = (): number => RealDate.now() + ++ticks;

  function TickingDate(): Date {
    return new RealDate(nextMs());
  }
  TickingDate.now = nextMs;
  TickingDate.parse = RealDate.parse;
  TickingDate.UTC = RealDate.UTC;
  TickingDate.prototype = RealDate.prototype;

  globalThis.Date = TickingDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

describe("a rebuilt session's id, startedAt and finishedAt match the stored ones exactly", () => {
  // A 4% race is a weak red: it can pass by luck on the very run meant to prove
  // it fails. This clock removes the luck — on today's code these two fail on
  // every run, not sometimes.
  it("start() and finish() under a clock that never lands on the same millisecond twice", async () => {
    const ctx = freshCtx("replay-clock");
    const restore = installEverTickingClock();
    try {
      openService(ctx);
      baptismTimerService.reset();
      baptismTimerService.setMode("per-person");

      baptismTimerService.start();
      const finished = baptismTimerService.finish();
      assert.equal(finished.people.length, 1, "sanity: the testimony alone still logs a session");
    } finally {
      restore();
    }

    await assertRoundTrip(ctx, "a clock that ticks on every read");
  });

  it("still matches through Finish, Undo, and a second Finish that replaces the same id", async () => {
    const ctx = freshCtx("replay-clock");
    const restore = installEverTickingClock();
    try {
      openService(ctx);
      baptismTimerService.reset();
      baptismTimerService.setMode("grouped");

      baptismTimerService.start();
      baptismTimerService.next(); // person 1's testimony ends, person 2's begins
      baptismTimerService.startBaptisms(); // person 2 folds in; two people, armed
      baptismTimerService.finish(); // Finish while armed — nobody has stepped in yet
      assert.equal(baptismTimerService.undo().armed, true, "sanity: armed again");
      baptismTimerService.advance(); // person 1 in
      baptismTimerService.next(); // person 2 in
      const finished = baptismTimerService.next(); // auto-finishes: the SECOND finalize()

      assert.equal(finished.people.length, 2, "sanity: neither person was skipped");
      assert.ok(finished.people.every((p) => p.baptizeMs > 0), "sanity: both were actually baptized");
    } finally {
      restore();
    }

    // finalize() ran twice for one session (Finish, Undo, Finish-via-auto) — the
    // store replaces by id, and the replay must log the SAME id both times, so
    // this is the path the strictly-increasing clock above has to hold for, not
    // just a single finish.
    await assertRoundTrip(ctx, "finish, undo, finish again, under the same ticking clock");
  });

  // Cheap insurance beyond the deterministic clock above: many real-clock
  // sessions back to back, asserted with the same strict equality. Unlike the
  // ticking clock this cannot be relied on to fail before the fix — the drift
  // it is checking for is the ~4% race itself — but every one of them must pass
  // after it, and none may regress back toward it.
  it("thirty ordinary driven sessions in a row, real clock", async () => {
    for (let i = 0; i < 30; i++) {
      const ctx = freshCtx("replay-bulk");
      openService(ctx);
      baptismTimerService.reset();
      baptismTimerService.setMode("per-person");
      baptismTimerService.start();
      baptismTimerService.finish();
      await assertRoundTrip(ctx, `driven session ${i + 1} of 30, real clock`);
    }
  });
});

describe("a real grouped session replays back into the session the store recorded", () => {
  it("run to its natural end, where the last person auto-finishes", async () => {
    const ctx = freshCtx("replay");
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
    const ctx = freshCtx("replay");
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
    const ctx = freshCtx("replay");
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
    const ctx = freshCtx("replay");
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

  it("a direct next() while armed: the skipped person replays unbaptized, the next one baptized", async () => {
    // POST /api/baptism/next while armed skips person 1 — no row, nobody's clock
    // ran — and starts person 2's, writing a baptisms-start at index 1 that no
    // advance() ever writes. The replay reads past it: it carries no session
    // content.
    const ctx = freshCtx("replay");
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    baptismTimerService.startBaptisms();
    baptismTimerService.next(); // direct, while armed
    await sleep(8);
    const finished = baptismTimerService.finish();

    assert.equal(finished.people[0]!.baptizeMs, 0, "sanity: person 1 was skipped");
    assert.ok(finished.people[1]!.baptizeMs > 0, "sanity: person 2 ran a clock");

    const [replayed] = await assertRoundTrip(ctx, "grouped, direct next() while armed");
    assert.equal(replayed!.people[0]!.baptizeMs, 0, "the skipped person replays unbaptized, not as a baptism");
  });
});

describe("a real per-person session replays back into the session the store recorded", () => {
  it("two people, closed by the Finish press that is its only terminator", async () => {
    const ctx = freshCtx("replay");
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
    const ctx = freshCtx("replay");
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
    const ctx = freshCtx("replay");
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
    await sleep(80); // the real baptism, far longer than the undone ~8ms attempt
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
    // Threshold between the two attempts, not on the sleep: an 80ms sleep
    // measures at least ~79ms and the undone attempt ~8ms. `>= 40` after
    // `sleep(40)` raced timer resolution — it failed reporting 39ms.
    assert.ok(
      replayed!.people[0]!.baptizeMs >= 50,
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
    const ctx = freshCtx("replay");
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
    await sleep(80); // the real baptism, far longer than the undone ~12ms attempt
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
    // The threshold sits well between the two attempts rather than on the sleep
    // itself: an 80ms sleep measures at least ~79ms, and the undone attempt is
    // ~12ms, so 50 leaves room on both sides. Asserting `>= 42` after
    // `sleep(42)` raced timer resolution and failed about one run in five.
    assert.ok(
      replayed!.people[1]!.baptizeMs >= 50,
      `person 1 carries the corrected attempt, not the one that was undone (got ${replayed!.people[1]!.baptizeMs}ms)`,
    );
  });

  it("armed on the wrong song, undone, re-armed — still one person", async () => {
    const ctx = freshCtx("replay");
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

  it("First person in pressed early and undone — the section re-arms, nobody dropped", async () => {
    // Undo after "First person in" takes back that press alone: armed again,
    // everyone still in `people`. Its row is `undo` with phase=baptism at
    // baptismIndex 0, which the replay reads as un-baptizing index 0 — and
    // person 1 has no completion row yet, so there is nothing to zero. The
    // replay has no rule of its own for this press; this proves it needs none.
    const ctx = freshCtx("replay");
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(12);
    baptismTimerService.next(); // person 1's testimony ends
    await sleep(12);
    const armed = baptismTimerService.startBaptisms(); // person 2's testimony folds in, section arms
    baptismTimerService.advance(); // "First person in", a beat early
    await sleep(40); // nobody is in the water
    baptismTimerService.undo(); // armed again, both people still waiting
    await sleep(20); // the real walk-up
    baptismTimerService.advance(); // "First person in"
    await sleep(12);
    baptismTimerService.advance(); // "Next person in"
    await sleep(12);
    const finished = baptismTimerService.finish(); // "Last person out"

    assert.equal(finished.people.length, 2, "sanity: two people testified, so the session holds two");
    assert.deepEqual(
      finished.people.map((p) => p.testimonyMs),
      armed.people.map((p) => p.testimonyMs),
      "sanity: no testimony absorbed the undone press or the walk-up after it",
    );

    await assertRoundTrip(ctx, "grouped, First person in undone");

    // The rows the replay just read: no completion for index 0 before the undo.
    const rows = (await readBaptismRows(ctx.serviceKey, ctx.serviceDate))!;
    assert.deepEqual(rows.map((r) => r.event), [
      "reset",
      "start",
      "testimony-end",
      "baptisms-armed",
      "baptisms-start",
      "undo",
      "baptisms-start",
      "person-complete",
      "person-complete",
      "finish",
    ]);
    const undoRow = rows.find((r) => r.event === "undo")!;
    assert.deepEqual(
      { phase: undoRow.phase, baptismIndex: undoRow.baptismIndex, detail: undoRow.detail },
      { phase: "baptism", baptismIndex: "0", detail: "from baptism" },
      "the undo lands in the baptism section at index 0, not back in the testimonies",
    );
  });

  it("per-person Baptized pressed early, undone, then pressed again", async () => {
    const ctx = freshCtx("replay");
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

// Undo after Finish reopens the session where Finish was pressed (see
// baptism-undo-finish.test.ts). Each reopening writes one `undo` row landing in
// the phase it reopened, and the replay has to make the same people of it the
// timer did.
describe("a real session reopened by an Undo after Finish replays back into the session the store recorded", () => {
  it("Finish while baptizing person 1 of 3, undone, then run to the end", async () => {
    const ctx = freshCtx("replay");
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    baptismTimerService.startBaptisms(); // three people, armed
    baptismTimerService.advance(); // person 1 in
    await sleep(8);
    baptismTimerService.finish(); // pressed two people early
    assert.equal(baptismTimerService.undo().baptismIndex, 0, "sanity: reopened on person 1");
    await sleep(8);
    baptismTimerService.next(); // person 1 out, person 2 in
    await sleep(8);
    baptismTimerService.next(); // person 2 out, person 3 in
    await sleep(8);
    const finished = baptismTimerService.next(); // person 3 out — auto-finishes

    assert.equal(finished.people.length, 3);
    assert.ok(finished.people.every((p) => p.baptizeMs > 0), "sanity: all three were baptized, nobody skipped");

    await assertRoundTrip(ctx, "grouped, early Finish undone");
  });

  it("Finish while armed, undone, then everyone baptized in order", async () => {
    const ctx = freshCtx("replay");
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    baptismTimerService.startBaptisms(); // two people, armed
    baptismTimerService.finish(); // before anyone stepped in
    assert.equal(baptismTimerService.undo().armed, true, "sanity: armed again");
    baptismTimerService.advance(); // person 1 in
    await sleep(8);
    baptismTimerService.next(); // person 2 in
    await sleep(8);
    const finished = baptismTimerService.next(); // auto-finishes

    assert.ok(finished.people.every((p) => p.baptizeMs > 0), "sanity: both baptized, person 1 not skipped");

    await assertRoundTrip(ctx, "grouped, armed Finish undone");
  });

  it("Finish during the testimonies, undone, then on into the baptisms", async () => {
    const ctx = freshCtx("replay");
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    baptismTimerService.finish(); // closes person 2's testimony, no baptisms
    assert.equal(baptismTimerService.undo().phase, "testimony", "sanity: person 2's testimony reopened");
    await sleep(8);
    baptismTimerService.startBaptisms();
    baptismTimerService.advance();
    await sleep(8);
    baptismTimerService.next();
    await sleep(8);
    const finished = baptismTimerService.next(); // auto-finishes

    assert.equal(finished.people.length, 2, "sanity: the reopened testimony is still one person");

    await assertRoundTrip(ctx, "grouped, testimony Finish undone");
  });

  it("per-person Finish during a testimony, undone, then Baptized taken back later on", async () => {
    // The pop belongs to the ONE undo that follows the finish. Baptized taken
    // back later lands in the testimony phase as well; carried forward to it,
    // the pop removes person 1, who finished long before.
    const ctx = freshCtx("replay");
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.baptized();
    await sleep(8);
    baptismTimerService.next(); // person 1 complete, person 2's testimony
    await sleep(8);
    baptismTimerService.finish(); // closes person 2's testimony
    baptismTimerService.undo(); // person 2's testimony reopened
    await sleep(8);
    baptismTimerService.baptized();
    await sleep(8);
    assert.equal(baptismTimerService.undo().phase, "testimony", "sanity: Baptized taken back");
    await sleep(8);
    baptismTimerService.baptized();
    await sleep(8);
    const finished = baptismTimerService.finish();

    assert.equal(finished.people.length, 2, "sanity: person 1 and person 2");

    await assertRoundTrip(ctx, "per-person, testimony Finish undone, then Baptized taken back");
  });

  it("per-person Finish during a testimony, undone, then baptized", async () => {
    const ctx = freshCtx("replay");
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");

    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.baptized();
    await sleep(8);
    baptismTimerService.next(); // person 1 complete, person 2's testimony
    await sleep(8);
    baptismTimerService.finish(); // closes person 2's testimony, never baptized
    assert.equal(baptismTimerService.undo().phase, "testimony", "sanity: person 2's testimony reopened");
    await sleep(8);
    baptismTimerService.baptized();
    await sleep(8);
    const finished = baptismTimerService.finish();

    assert.equal(finished.people.length, 2);

    const [replayed] = await assertRoundTrip(ctx, "per-person, testimony Finish undone");
    assert.equal(
      replayed!.people.length,
      2,
      "the undo pops the person that Finish pushed, however much it looks like the per-person undo that pops nobody",
    );
  });
});

describe("a service with no baptism archive has nothing to rebuild from", () => {
  it("readBaptismRows returns null, the same contract rebuildSplItems has", async () => {
    assert.equal(await readBaptismRows("st1:plan1:never-recorded", "2026-09-20"), null);
  });
});
