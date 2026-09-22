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
// a moment after the timer read its own clock for the same press — see the
// header of rebuild-baptism.ts, which measured it at 0–1ms. So each span can be
// off by about a millisecond at each end, and a person's sum by that much per
// piece. TOLERANCE_MS allows 4ms per piece; every stretch these scenarios need
// to tell apart runs 25ms or more, so a missing or extra piece cannot hide inside
// it.
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

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-lane-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService: timer } = await import("../baptism-timer-service.js");
const { sampleArchive } = await import("./sample-archive.js");
const { readBaptismRows } = await import("./rebuild-baptism.js");
const { baptismLaneSpans } = await import("./baptism-lane.js");
const { freshCtx, openService, sleep, storedSessions } = await import("./baptism-roundtrip-harness.js");

type Ctx = { serviceKey: string; serviceDate: string };

const TOLERANCE_MS = 4;

const ms = (s: BaptismSpan) => Date.parse(s.endedAt ?? "") - Date.parse(s.startedAt);

/** A fresh service, open, with the timer idle in `mode`. */
function begin(mode: "grouped" | "per-person"): Ctx {
  const ctx = freshCtx("lane");
  openService(ctx);
  timer.reset();
  timer.setMode(mode);
  return ctx;
}

async function laneOf(ctx: Ctx): Promise<BaptismSpan[]> {
  await sampleArchive.flush();
  const rows = await readBaptismRows(ctx.serviceKey, ctx.serviceDate);
  assert.ok(rows && rows.length > 0, "the archive holds rows for this service");
  return baptismLaneSpans(rows!, ctx.serviceKey);
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
        pieces.length > 0 && Math.abs(sum - recorded) <= TOLERANCE_MS * pieces.length,
        `${why}: person ${person}'s ${kind} spans sum to ${sum}ms over ${pieces.length} piece(s); the store recorded ${recorded}ms`,
      );
    }
  });
}

/**
 * Derive this service's lane from its real rows and hold it to the sessions the
 * store recorded. Returns the spans so a scenario can make its own claims.
 */
async function assertLaneMatchesStore(ctx: Ctx, why: string, sessions = 1): Promise<BaptismSpan[]> {
  const spans = await laneOf(ctx);
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
    await sleep(25);
    timer.next(); // person 1's testimony ends, person 2's begins
    await sleep(25);
    timer.startBaptisms(); // person 2 folds in, the section arms
    await sleep(25); // the band's intro: nobody's clock
    timer.advance(); // first person in
    await sleep(25);
    timer.next(); // person 1 out, person 2 in
    await sleep(25);
    timer.next(); // person 2 out — auto-finishes

    const spans = await assertLaneMatchesStore(ctx, "grouped, natural end");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "baptism 1", "baptism 2"]);
    const intro = Date.parse(spans[2]!.startedAt) - Date.parse(spans[1]!.endedAt!);
    assert.ok(intro >= 20, `the armed stretch is a gap, not anybody's (got ${intro}ms)`);
  });

  it("with a pause mid-testimony, closed by Last person out", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.pause();
    await sleep(30); // a prayer: not person 1's testimony
    timer.resume();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    timer.advance();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.finish(); // the panel's "Last person out" is finish(), not next()

    const spans = await assertLaneMatchesStore(ctx, "grouped, pause mid-testimony");
    assert.equal(spans.filter((s) => s.kind === "testimony" && s.person === 1).length, 2, "the pause splits person 1's testimony in two");
  });

  it("finished mid-baptism, the second person never baptized", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    timer.advance();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, finished mid-baptism");
  });

  it("finished during the testimonies", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, finished in the testimonies");
  });

  it("finished while armed, before anyone stepped in", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    await sleep(25);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "grouped, finished while armed");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2"]);
  });

  it("paused during a baptism, and a Pause pressed while armed does nothing", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.startBaptisms();
    timer.pause(); // armed: nothing to bank, no row
    await sleep(25);
    timer.advance();
    await sleep(25);
    timer.pause();
    await sleep(30);
    timer.resume();
    await sleep(25);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "grouped, paused baptism");
    assert.deepEqual(shape(spans), ["testimony 1", "baptism 1", "baptism 1"]);
  });
});

describe("a real per-person session's lane is the time the store recorded", () => {
  it("two people, closed by finish(), its only terminator", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(25);
    timer.baptized();
    await sleep(25);
    timer.next(); // person 1 done, person 2's testimony begins
    await sleep(25);
    timer.baptized();
    await sleep(25);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "per-person, two people");
    assert.deepEqual(shape(spans), ["testimony 1", "baptism 1", "testimony 2", "baptism 2"]);
  });

  it("paused in a testimony and again in a baptism", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(25);
    timer.pause();
    await sleep(30);
    timer.resume();
    await sleep(25);
    timer.baptized();
    await sleep(25);
    timer.pause();
    await sleep(30);
    timer.resume();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "per-person, two pauses");
  });

  it("finished in the testimony, before any baptism", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(25);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "per-person, finished in the testimony");
    assert.deepEqual(shape(spans), ["testimony 1"]);
  });
});

describe("a real session containing an undo: the lane is still the time the store recorded", () => {
  it("an undo that re-baptizes the same person keeps only the second attempt", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    timer.advance();
    await sleep(25);
    timer.next(); // person 1 out — a beat early
    await sleep(25); // person 2's clock runs, and is thrown away
    timer.undo(); // back to person 1, timed afresh
    await sleep(40);
    timer.next();
    await sleep(25);
    timer.next(); // auto-finishes

    const spans = await assertLaneMatchesStore(ctx, "grouped, undo and re-baptize");
    const first = spans.filter((s) => s.kind === "baptism" && s.person === 1);
    assert.equal(first.length, 1, "the undone attempt is a gap, not a second piece of person 1's baptism");
    assert.ok(ms(first[0]!) >= 40, `person 1's baptism is the second attempt (got ${ms(first[0]!)}ms)`);
  });

  it("arm, undo, re-arm: one person, the armed stretch a gap", async () => {
    const ctx = begin("grouped");
    timer.start(); // the only person
    await sleep(40);
    timer.startBaptisms(); // wrong song
    await sleep(25);
    timer.undo(); // back into the testimony, resumed from what it banked
    await sleep(25);
    timer.startBaptisms(); // right song
    await sleep(25);
    timer.advance();
    await sleep(25);
    timer.finish();

    const spans = await assertLaneMatchesStore(ctx, "grouped, arm/undo/re-arm");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 1", "baptism 1"]);
  });

  it("a testimony next() closed a beat early, taken back", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next(); // early
    await sleep(25); // person 2's testimony, thrown away
    timer.undo();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    timer.advance();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, testimony undo");
  });

  it("correcting the second of three people leaves the first one's baptism alone", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    timer.advance();
    await sleep(25);
    timer.next(); // index 0 baptized
    await sleep(25);
    timer.next(); // index 1 baptized — early
    await sleep(25);
    timer.undo(); // back to index 1, NOT index 0
    await sleep(40);
    timer.next();
    await sleep(25);
    timer.next(); // index 2, auto-finishes
    await assertLaneMatchesStore(ctx, "grouped, undo at index 1 of three");
  });

  it("the arming undone after the first person had stepped in", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    timer.advance();
    await sleep(25); // person 1's baptism, thrown away with the arming
    timer.undo(); // person 2's testimony resumes
    await sleep(25);
    timer.startBaptisms();
    timer.advance();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, arming undone mid-baptism");
  });

  it("grouped finish, undo, finish again: the last baptism re-timed", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.startBaptisms();
    timer.advance();
    await sleep(25);
    timer.finish();
    timer.undo(); // un-finish
    await sleep(30);
    timer.finish();
    await assertLaneMatchesStore(ctx, "grouped, finish/undo/finish");
  });

  it("per-person Baptized pressed early, undone, then pressed again", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(40);
    timer.baptized(); // early
    await sleep(25);
    timer.undo(); // the testimony resumes
    await sleep(25);
    timer.baptized();
    await sleep(25);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "per-person, Baptized undone");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 1", "baptism 1"]);
  });

  it("per-person Next pressed early, undone back into the baptism", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(25);
    timer.baptized();
    await sleep(25);
    timer.next(); // early
    await sleep(25); // person 2's testimony, thrown away
    timer.undo(); // person 1's baptism, timed afresh
    await sleep(30);
    timer.next();
    await sleep(25);
    timer.baptized();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "per-person, Next undone");
  });

  it("per-person finish, undo, finish again", async () => {
    const ctx = begin("per-person");
    timer.start();
    await sleep(25);
    timer.baptized();
    await sleep(25);
    timer.finish();
    timer.undo();
    await sleep(30);
    timer.finish();
    await assertLaneMatchesStore(ctx, "per-person, finish/undo/finish");
  });
});

describe("session boundaries on a real lane", () => {
  it("a session reset part-way leaves nothing; the session after it is drawn", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.reset(); // nothing logged: that time is in no session
    await sleep(25);
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "reset, then a second session");
  });

  it("two sessions in one service each match their own stored session", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.finish();
    await sleep(25);
    timer.setMode("per-person");
    timer.start();
    await sleep(25);
    timer.baptized();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "two sessions", 2);
  });
});

describe("the clock a direct next() starts while armed, with no row of its own", () => {
  it("is placed from the person-complete that ends it", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    await sleep(25);
    timer.next(); // POST /api/baptism/next while armed: person 1 skipped, person 2's clock starts, no row
    await sleep(30);
    timer.finish();
    const spans = await assertLaneMatchesStore(ctx, "direct next() while armed");
    assert.deepEqual(shape(spans), ["testimony 1", "testimony 2", "baptism 2"]);
  });

  it("is placed from the pause that banks it", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);
    timer.startBaptisms();
    timer.next(); // silent
    await sleep(25);
    timer.pause();
    await sleep(30);
    timer.resume();
    await sleep(25);
    timer.finish();
    await assertLaneMatchesStore(ctx, "direct next() while armed, then a pause");
  });
});

describe("a real session still running", () => {
  it("ends with the running clock as the last span, open, starting where the timer's segment does", async () => {
    const ctx = begin("grouped");
    timer.start();
    await sleep(25);
    timer.next();
    await sleep(25);

    const running = await laneOf(ctx);
    const state = timer.getState();
    assertOneClockAtATime(running, "running");
    assert.deepEqual(shape(running), ["testimony 1", "testimony 2"]);
    assert.equal(running[1]!.endedAt, null, "person 2's testimony is still running");
    assert.ok(
      Math.abs(Date.parse(running[1]!.startedAt) - Date.parse(state.segmentStartedAt!)) <= TOLERANCE_MS,
      "the open span starts where the timer's running segment does, so a client can grow it from segmentStartedAt",
    );
    assertSpansArePeople(running.slice(0, 1), state.people, "running");

    timer.pause();
    const paused = await laneOf(ctx);
    assert.ok(paused.every((s) => s.endedAt !== null), "paused, nothing runs");
    assert.ok(
      Math.abs(ms(paused[1]!) - (timer.getState().segmentAccumMs ?? 0)) <= TOLERANCE_MS,
      "the paused span is what the timer banked",
    );
    timer.reset();
  });
});
