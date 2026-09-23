// baptism-lane-roundtrip.test.ts — the guard that matters for the lane.
//
// Every test drives the REAL baptismTimerService against a real temp data dir,
// lets the REAL sampleArchive write real rows, reads them back with the REAL
// readBaptismRows, derives the lane, and holds it to what the store recorded:
//
//   • for every person, their testimony spans sum to their `testimonyMs` and
//     their baptism spans to their `baptizeMs`;
//   • a person who recorded no time of a kind has no span of that kind — a
//     zero-length span passes the sum and is still a baptism that did not
//     happen, drawn on the lane;
//   • every span names a person the session has, and lies inside a session the
//     store holds — time in no recorded session is not the session's;
//   • one clock at a time: no span starts before the one before it ends, and a
//     finished session leaves nothing running.
//
// A lane that shows time the session did not record, or drops time it did,
// fails here. That is what ties the lane to the data.
//
// THE TOLERANCE. Spans are drawn from each row's `at`, which recordBaptism stamps
// a moment after the timer read its own clock for the same press. Normally that
// moment is 0–1ms (see the header of rebuild-baptism.ts), but anything that stalls
// the process between the two reads — a GC pause on a loaded machine — moves a
// boundary by the length of the stall. A flat 4ms failed 1 run in 48 under heavy
// load for exactly that reason.
//
// So the allowance is proportional: a fifth of the time being compared, never
// under 4ms a piece (toleranceMs below). What the invariant exists to catch is a
// lane that drops or duplicates a whole stretch, not a boundary a few
// milliseconds late. Every stretch these scenarios need to tell apart runs
// STRETCH_MS or LONG_MS, and no person has more than two pieces of one kind, so a
// dropped or extra stretch is at least twice the allowance of any total it could
// hide in.
//
// PR 3's Task 16 threads the timer's own stamp through emitRaw, so a row will
// carry exactly the instant the timer used. Tighten this back to a flat
// millisecond or two then; the proportional allowance is standing in for that
// fix, not replacing it.
//
// Shares its harness with rebuild-baptism-roundtrip.test.ts
// (baptism-roundtrip-harness.ts): a fresh serviceKey per test, because the
// archive is an append-only CSV keyed by it and the singleton sampleArchive never
// resets between tests in one file.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { BaptismPerson } from "../../types/stage.js";
import type { BaptismSpan } from "./baptism-lane.js";
import type { BaptismRow } from "./rebuild-baptism.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-lane-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService: timer } = await import("../baptism-timer-service.js");
const { sampleArchive } = await import("./sample-archive.js");
const { readBaptismRows } = await import("./rebuild-baptism.js");
const { baptismLaneSpans } = await import("./baptism-lane.js");
const { freshCtx, openService, sleep, storedSessions } = await import("./baptism-roundtrip-harness.js");

type Ctx = { serviceKey: string; serviceDate: string };

/** One counted stretch: a testimony, a baptism, or a piece of either. */
const STRETCH_MS = 60;
/** A stretch that has to read as longer than STRETCH_MS — the attempt an undo
 *  re-times, against the one it threw away. */
const LONG_MS = 100;

/** How far a sum of `pieces` spans may drift from `comparedMs` before it counts as
 *  a different amount of time. See the header. */
function toleranceMs(comparedMs: number, pieces = 1): number {
  return Math.max(4 * pieces, 0.2 * comparedMs);
}

const ms = (s: BaptismSpan) => Date.parse(s.endedAt ?? "") - Date.parse(s.startedAt);

/** A fresh service, open, with the timer idle in `mode`. */
function begin(mode: "grouped" | "per-person"): Ctx {
  const ctx = freshCtx("lane");
  openService(ctx);
  timer.reset();
  timer.setMode(mode);
  return ctx;
}

/** Rows as read, unless a scenario needs the file as an older emitter wrote it. */
type RowEdit = (rows: BaptismRow[]) => BaptismRow[];
const asWritten: RowEdit = (rows) => rows;

async function laneOf(ctx: Ctx, edit: RowEdit = asWritten): Promise<BaptismSpan[]> {
  await sampleArchive.flush();
  const rows = await readBaptismRows(ctx.serviceKey, ctx.serviceDate);
  assert.ok(rows && rows.length > 0, "the archive holds rows for this service");
  return baptismLaneSpans(edit(rows!), ctx.serviceKey);
}

/** One clock at a time: every span ends before the next begins, and only the
 *  last may still be running. */
function assertOneClockAtATime(spans: BaptismSpan[], why: string): void {
  spans.forEach((s, i) => {
    if (s.endedAt !== null) assert.ok(ms(s) >= 0, `${why}: span ${i} ends before it starts`);
    else assert.equal(i, spans.length - 1, `${why}: span ${i} is running but is not the last`);
    if (i === 0) return;
    const before = spans[i - 1]!;
    assert.ok(
      Date.parse(s.startedAt) >= Date.parse(before.endedAt ?? ""),
      `${why}: span ${i} (${s.kind} ${s.person}) starts before span ${i - 1} (${before.kind} ${before.person}) ends`,
    );
  });
}

/** The invariant: these spans are exactly the time these people recorded. */
function assertSpansArePeople(spans: BaptismSpan[], people: BaptismPerson[], why: string): void {
  for (const s of spans) {
    assert.ok(
      s.person >= 1 && s.person <= people.length,
      `${why}: a ${s.kind} span names person ${s.person}, and the session has ${people.length}`,
    );
  }
  people.forEach((p, i) => {
    const person = i + 1;
    for (const [kind, recorded] of [["testimony", p.testimonyMs], ["baptism", p.baptizeMs]] as const) {
      const pieces = spans.filter((s) => s.kind === kind && s.person === person);
      if (recorded === 0) {
        assert.equal(pieces.length, 0, `${why}: person ${person} recorded no ${kind}, and the lane draws ${pieces.length} span(s) of it`);
        continue;
      }
      const sum = pieces.reduce((t, s) => t + ms(s), 0);
      assert.ok(
        pieces.length > 0 && Math.abs(sum - recorded) <= toleranceMs(recorded, pieces.length),
        `${why}: person ${person}'s ${kind} spans sum to ${sum}ms over ${pieces.length} piece(s); the store recorded ${recorded}ms`,
      );
    }
  });
}

/**
 * Derive this service's lane from its real rows and hold it to the sessions the
 * store recorded. Returns the spans so a scenario can make its own claims.
 */
async function assertLaneMatchesStore(
  ctx: Ctx,
  why: string,
  sessions = 1,
  edit: RowEdit = asWritten,
): Promise<BaptismSpan[]> {
  const spans = await laneOf(ctx, edit);
  // listSessions() is newest-first; the lane is chronological.
  const stored = [...(await storedSessions(ctx, sessions))].reverse();
  assert.equal(stored.length, sessions, `${why}: the store holds ${sessions} session(s) for this service`);

  assertOneClockAtATime(spans, why);
  assert.ok(spans.every((s) => s.endedAt !== null), `${why}: a finished session leaves no span running`);

  let unowned = [...spans];
  stored.forEach((session, n) => {
    const from = Date.parse(session.startedAt);
    const to = Date.parse(session.finishedAt);
    const mine = spans.filter((s) => Date.parse(s.startedAt) >= from && Date.parse(s.endedAt ?? "") <= to);
    unowned = unowned.filter((s) => !mine.includes(s));
    assertSpansArePeople(mine, session.people, stored.length > 1 ? `${why}, session ${n + 1}` : why);
  });
  assert.deepEqual(
    unowned.map((s) => `${s.kind} ${s.person} ${s.startedAt}`),
    [],
    `${why}: every span lies inside a session the store recorded`,
  );
  return spans;
}

const shape = (spans: BaptismSpan[]) => spans.map((s) => `${s.kind} ${s.person}`);

describe("a real grouped session's lane is the time the store recorded", () => {
  it("run to its natural end, the last person auto-finishing", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next(); // person 1's testimony ends, person 2's begins
    await sleep(STRETCH_MS);
    timer.startBaptisms(); // person 2 folds in, the section arms
    await sleep(STRETCH_MS); // the band's intro: nobody's clock
    timer.advance(); // first person in
    await sleep(STRETCH_MS);
    timer.next(); // person 1 out, person 2 in
    await sleep(STRETCH_MS);
    timer.next(); // person 2 out — auto-finishes

    const spans = await assertLaneMatchesStore(ctx, "grouped, natural end");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "baptism 1", "baptism 2"]);
    const intro = Date.parse(spans[2]!.startedAt) - Date.parse(spans[1]!.endedAt!);
    assert.ok(intro >= STRETCH_MS / 2, `the armed stretch is a gap, not anybody's (got ${intro}ms)`);
  });

  it("with a pause mid-testimony, closed by Last person out", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.pause();
    await sleep(STRETCH_MS); // a prayer: not person 1's testimony
    timer.resume();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.finish(); // the panel's "Last person out" is finish(), not next()

    const spans = await assertLaneMatchesStore(ctx, "grouped, pause mid-testimony");
    assert.equal(spans.filter((s) => s.kind === "testimony" && s.person === 1).length, 2, "the pause splits person 1's testimony in two");
  });

  it("finished mid-baptism, the second person never baptized", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, finished mid-baptism");
  });

  it("finished during the testimonies", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, finished in the testimonies");
  });

  it("finished while armed, before anyone stepped in", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    await sleep(STRETCH_MS);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "grouped, finished while armed");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2"]);
  });

  it("paused during a baptism, and a Pause pressed while armed does nothing", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.pause(); // armed: nothing to bank, no row
    await sleep(STRETCH_MS);
    timer.advance();
    await sleep(STRETCH_MS);
    timer.pause();
    await sleep(STRETCH_MS);
    timer.resume();
    await sleep(STRETCH_MS);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "grouped, paused baptism");
    assert.deepEqual(shape(spans), ["testimony 1", "baptism 1", "baptism 1"]);
  });
});

describe("a real per-person session's lane is the time the store recorded", () => {
  it("two people, closed by finish(), its only terminator", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.next(); // person 1 done, person 2's testimony begins
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "per-person, two people");
    assert.deepEqual(shape(spans), ["testimony 1", "baptism 1", "testimony 2", "baptism 2"]);
  });

  it("paused in a testimony and again in a baptism", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(STRETCH_MS);
    timer.pause();
    await sleep(STRETCH_MS);
    timer.resume();
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.pause();
    await sleep(STRETCH_MS);
    timer.resume();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "per-person, two pauses");
  });

  it("finished in the testimony, before any baptism", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(STRETCH_MS);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "per-person, finished in the testimony");
    assert.deepEqual(shape(spans), ["testimony 1"]);
  });
});

describe("a real session containing an undo: the lane is still the time the store recorded", () => {
  it("an undo that re-baptizes the same person keeps only the second attempt", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS);
    timer.next(); // person 1 out — a beat early
    await sleep(STRETCH_MS); // person 2's clock runs, and is thrown away
    const undoneAt = Date.now();
    timer.undo(); // back to person 1, timed afresh
    await sleep(LONG_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.next(); // auto-finishes

    const spans = await assertLaneMatchesStore(ctx, "grouped, undo and re-baptize");
    const first = spans.filter((s) => s.kind === "baptism" && s.person === 1);
    assert.equal(first.length, 1, "the undone attempt is a gap, not a second piece of person 1's baptism");
    // Placed, not measured: a stretch's length moves with timer overshoot under
    // load, where it starts does not. The undo row is stamped after undoneAt.
    assert.ok(
      Date.parse(first[0]!.startedAt) >= undoneAt,
      `person 1's baptism is the attempt timed from the undo, not the one before it (started ${first[0]!.startedAt})`,
    );
  });

  it("arm, undo, re-arm: one person, the armed stretch a gap", async () => {
    const ctx = begin("grouped");
    timer.start(); // the only person
    await sleep(STRETCH_MS);
    timer.startBaptisms(); // wrong song
    await sleep(STRETCH_MS);
    timer.undo(); // back into the testimony, resumed from what it banked
    await sleep(STRETCH_MS);
    timer.startBaptisms(); // right song
    await sleep(STRETCH_MS);
    timer.advance();
    await sleep(STRETCH_MS);
    timer.finish();

    const spans = await assertLaneMatchesStore(ctx, "grouped, arm/undo/re-arm");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 1", "baptism 1"]);
  });

  it("a testimony next() closed a beat early, taken back", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next(); // early
    await sleep(STRETCH_MS); // person 2's testimony, thrown away
    timer.undo();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, testimony undo");
  });

  it("correcting the second of three people leaves the first one's baptism alone", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS);
    timer.next(); // index 0 baptized
    await sleep(STRETCH_MS);
    timer.next(); // index 1 baptized — early
    await sleep(STRETCH_MS);
    timer.undo(); // back to index 1, NOT index 0
    await sleep(LONG_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.next(); // index 2, auto-finishes
    await assertLaneMatchesStore(ctx, "grouped, undo at index 1 of three");
  });

  // "First person in" taken back re-arms, and its undo row is byte-identical to
  // a step back from person 2 onto person 1 — baptism, baptismIndex 0, "from
  // baptism". The step back is covered above; these are the re-arm.
  it("First person in taken back: person 1's clock is thrown away, and the re-armed wait is a gap", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS); // person 1's clock, thrown away by the undo
    const undoneAt = Date.now();
    timer.undo(); // armed again: nobody's clock runs, person 2 still waiting
    await sleep(STRETCH_MS); // still waiting for person 1
    timer.advance(); // "First person in", this time for real
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.finish();

    const spans = await assertLaneMatchesStore(ctx, "grouped, First person in taken back");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "baptism 1", "baptism 2"]);
    const wait = Date.parse(spans[2]!.startedAt) - undoneAt;
    assert.ok(wait >= STRETCH_MS / 2, `the re-armed wait is a gap, not person 1's baptism (got ${wait}ms)`);
  });

  it("First person in taken back while paused: the same, though no clock was running to stop", async () => {
    // The pause already closed person 1's span, so nothing is open at the undo
    // — whose clock it was has to be read off the last span, not the open one.
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS);
    timer.pause(); // person 1's clock banked
    await sleep(STRETCH_MS);
    timer.undo(); // armed again, the bank thrown away with the press
    await sleep(STRETCH_MS);
    timer.advance();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.finish();

    const spans = await assertLaneMatchesStore(ctx, "grouped, First person in taken back while paused");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "baptism 1", "baptism 2"]);
  });

  it("grouped finish, undo, finish again: the baptism Finish closed, re-timed", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS);
    timer.finish();
    timer.undo(); // un-finish
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, finish/undo/finish");
  });

  it("per-person Baptized pressed early, undone, then pressed again", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(STRETCH_MS);
    timer.baptized(); // early
    await sleep(STRETCH_MS);
    timer.undo(); // the testimony resumes
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "per-person, Baptized undone");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 1", "baptism 1"]);
  });

  it("per-person Next pressed early, undone back into the baptism", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.next(); // early
    await sleep(STRETCH_MS); // person 2's testimony, thrown away
    timer.undo(); // person 1's baptism, timed afresh
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "per-person, Next undone");
  });

  it("per-person finish, undo, finish again", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.finish();
    timer.undo();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "per-person, finish/undo/finish");
  });
});

// Undo after Finish reopens the session where Finish was pressed (see
// baptism-undo-finish.test.ts), so the lane has to reopen it there too.
describe("a real session reopened by an Undo after Finish: the lane is still the time the store recorded", () => {
  it("Finish while baptizing person 1 of 3, undone: person 1 re-timed, nobody skipped", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms(); // three people, armed
    timer.advance();
    await sleep(STRETCH_MS); // person 1's first attempt, thrown away with the Finish
    timer.finish();
    const undoneAt = Date.now();
    timer.undo();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.next(); // person 3 out — auto-finishes

    const spans = await assertLaneMatchesStore(ctx, "grouped, early Finish undone");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "testimony 3", "baptism 1", "baptism 2", "baptism 3"]);
    const first = spans.find((s) => s.kind === "baptism" && s.person === 1)!;
    assert.ok(Date.parse(first.startedAt) >= undoneAt, "person 1's baptism is the one timed from the Undo");
  });

  it("Finish while armed, undone: armed again, and the wait before the first press is a gap", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms(); // two people, armed
    timer.finish(); // before anyone stepped in
    const undoneAt = Date.now();
    timer.undo(); // armed again
    await sleep(STRETCH_MS); // still waiting for person 1: nobody's time
    timer.advance();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.next(); // auto-finishes

    const spans = await assertLaneMatchesStore(ctx, "grouped, armed Finish undone");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "baptism 1", "baptism 2"]);
    const wait = Date.parse(spans[2]!.startedAt) - undoneAt;
    assert.ok(wait >= STRETCH_MS / 2, `the re-armed wait is a gap, not person 1's baptism (got ${wait}ms)`);
  });

  it("Finish while armed, undone, then a step back later on: only the undo straight after the finish reopens it", async () => {
    // The re-arm reading belongs to the ONE undo that follows the finish. The
    // step back later writes baptism, baptismIndex 0 as well; carried forward to
    // it, that reading re-arms instead of re-timing person 1, and person 1 and
    // person 2 each keep the attempt the step back threw away.
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms(); // two people, armed
    timer.finish(); // before anyone stepped in
    timer.undo(); // armed again
    await sleep(STRETCH_MS);
    timer.advance(); // person 1 in
    await sleep(STRETCH_MS);
    timer.next(); // person 1 out a beat early, person 2 in
    await sleep(STRETCH_MS);
    assert.equal(timer.undo().baptismIndex, 0, "sanity: the step back lands on person 1");
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.next(); // auto-finishes

    const spans = await assertLaneMatchesStore(ctx, "grouped, armed Finish undone, then a step back");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "baptism 1", "baptism 2"]);
  });

  it("Finish during the testimonies, undone: the testimony resumes", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.finish(); // closes person 2's testimony
    timer.undo(); // person 2 resumes
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.advance();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.finish();

    const spans = await assertLaneMatchesStore(ctx, "grouped, testimony Finish undone");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "testimony 2", "baptism 1", "baptism 2"]);
  });

  it("per-person Finish during a testimony, undone: the testimony resumes, then its baptism", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.next(); // person 2's testimony
    await sleep(STRETCH_MS);
    timer.finish(); // closes person 2's testimony
    timer.undo(); // person 2 resumes
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.finish();

    const spans = await assertLaneMatchesStore(ctx, "per-person, testimony Finish undone");
    assert.deepEqual(shape(spans), ["testimony 1", "baptism 1", "testimony 2", "testimony 2", "baptism 2"]);
  });
});

describe("session boundaries on a real lane", () => {
  it("a session reset part-way leaves nothing; the session after it is drawn", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.reset(); // nothing logged: that time is in no session
    await sleep(STRETCH_MS);
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "reset, then a second session");
  });

  it("two sessions in one service each match their own stored session", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.finish();
    await sleep(STRETCH_MS);
    timer.setMode("per-person");
    timer.start();
    await sleep(STRETCH_MS);
    timer.baptized();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "two sessions", 2);
  });
});

/**
 * The file as it read before a direct next() while armed wrote a row: the same
 * presses, minus that press's `baptisms-start`. advance() writes its own at
 * baptismIndex 0 and only the direct next() writes one further in, so that is
 * the row removed — and exactly one, or the strip proved nothing.
 */
const withoutDirectNextStart: RowEdit = (rows) => {
  const kept = rows.filter((r) => !(r.event === "baptisms-start" && r.baptismIndex !== "0"));
  assert.equal(rows.length - kept.length, 1, "exactly one baptisms-start came from the direct next()");
  return kept;
};

describe("the clock a direct next() starts while armed", () => {
  // Each session is read twice. As written, the clock opens on the
  // baptisms-start row the direct next() writes. With that row stripped — a
  // file from before it existed — the lane still places the clock from the row
  // that ends or banks it, the only path in baptism-lane.ts that nothing the
  // emitter writes now reaches.
  it("opens on its own baptisms-start, and without it is placed from the person-complete that ends it", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    await sleep(STRETCH_MS);
    timer.next(); // POST /api/baptism/next while armed: person 1 skipped, person 2's clock starts
    await sleep(STRETCH_MS);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "direct next() while armed");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "baptism 2"]);
    const inferred = await assertLaneMatchesStore(ctx, "direct next() while armed, its row stripped", 1, withoutDirectNextStart);
    assert.deepEqual(shape(inferred), ["testimony 1", "testimony 2", "baptism 2"]);
  });

  it("opens on its own baptisms-start, and without it is placed from the pause that banks it", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);
    timer.startBaptisms();
    timer.next(); // direct, while armed
    await sleep(STRETCH_MS);
    timer.pause();
    await sleep(STRETCH_MS);
    timer.resume();
    await sleep(STRETCH_MS);
    timer.finish();
    await assertLaneMatchesStore(ctx, "direct next() while armed, then a pause");
    await assertLaneMatchesStore(ctx, "direct next() while armed, then a pause, its row stripped", 1, withoutDirectNextStart);
  });
});

describe("a real session still running", () => {
  it("ends with the running clock as the last span, open, starting where the timer's segment does", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(STRETCH_MS);
    timer.next();
    await sleep(STRETCH_MS);

    const running = await laneOf(ctx);
    const state = timer.getState();
    assertOneClockAtATime(running, "running");
    assert.deepEqual(shape(running), ["testimony 1", "testimony 2"]);
    assert.equal(running[1]!.endedAt, null, "person 2's testimony is still running");
    // A boundary, not a length: held to the allowance of the stretch a client
    // grows from it.
    assert.ok(
      Math.abs(Date.parse(running[1]!.startedAt) - Date.parse(state.segmentStartedAt!)) <= toleranceMs(STRETCH_MS),
      "the open span starts where the timer's running segment does, so a client can grow it from segmentStartedAt",
    );
    assertSpansArePeople(running.slice(0, 1), state.people, "running");

    timer.pause();
    const paused = await laneOf(ctx);
    const banked = timer.getState().segmentAccumMs ?? 0;
    assert.ok(paused.every((s) => s.endedAt !== null), "paused, nothing runs");
    assert.ok(Math.abs(ms(paused[1]!) - banked) <= toleranceMs(banked), "the paused span is what the timer banked");
    timer.reset();
  });
});
