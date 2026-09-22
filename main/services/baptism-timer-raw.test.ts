// baptism-timer-raw.test.ts — every baptism timer action lands in the raw
// layer, including the LAST person in a grouped session, and the LAST person
// in a per-person session (finish() is the only way a per-person session
// ends — next() in per-person mode never auto-finishes).
//
// The task-6 brief's emit table said to place "person-complete" immediately
// before each `return this.commit()`. But TWO methods delegate to the private
// finalize() instead of committing directly: next()'s grouped-baptism branch
// (for the last person, auto-finishing) and finish() (every branch). Followed
// literally, the row for whichever person that delegation closes is never
// written, and a replay reconstructs them with baptizeMs: 0 — on EVERY
// per-person session (finish() is its only terminator) and on every grouped
// session that runs to its natural end. This file drives both paths and
// proves the closing person's row survives with their real time.
//
// EVERY test that drives a session and reads the archive asserts the FULL
// ordered `event` list for that run, not a filtered count. A per-path count
// (`c.filter("x").length`) only proves an event still fires somewhere; it does
// not prove which action produced it, and it cannot catch a wrong event
// firing in place of the right one. Concretely: deleting `baptized()`'s
// `testimony-end` emit — the ONLY place a per-person testimony time reaches a
// structured column — left every per-person `c.filter("person-complete")`
// count in an earlier version of this file unchanged, because it fired on a
// different call. Only an ordered `c.events()` assertion, applied to every
// path this file drives (not just one), catches that.
//
// Also covers: startBaptisms() folding the final testimony into the arming
// row without losing its testimonyMs to a structured column; the raw layer
// never throwing back into the timer; the "no service open" latch logging
// once per session; that personNumber — not baptismIndex — is the field that
// freezes in grouped mode; and that neither next() nor finish() writes a
// person-complete row for a person closed while still armed (nobody's clock
// ever ran for them).
//
// Each `it` uses its OWN serviceKey: the archive is an append-only CSV keyed
// by serviceKey, and the singleton sampleArchive never resets between tests
// in one file, so sharing a key would let one test's rows bleed into the next
// test's row-count and event-order assertions.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-raw-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("./baptism-timer-service.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { sampleArchive } = await import("./archive/sample-archive.js");
const { parseRows } = await import("./csv.js");

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };
const rec = () => serviceTimelineRecorder as unknown as Held;

let ctxCounter = 0;
/** A fresh, never-reused serviceKey so this test's archive rows cannot mix
 *  with another test's. */
function freshCtx() {
  ctxCounter += 1;
  return { serviceKey: `st1:plan1:key${ctxCounter}`, serviceDate: "2026-09-20" };
}

/** Open the service this ctx names, so emitRaw's gate passes for it. */
function openService(ctx: { serviceKey: string; serviceDate: string }): void {
  rec().current = { ...ctx, endedAt: null };
}

function archiveDir(ctx: { serviceKey: string; serviceDate: string }): string {
  return path.join(TMP, "archive", `${ctx.serviceDate}_${ctx.serviceKey.replace(/:/g, "-")}`);
}

async function baptismRows(ctx: { serviceKey: string; serviceDate: string }): Promise<string[][]> {
  await sampleArchive.flush();
  return parseRows(await fs.readFile(path.join(archiveDir(ctx), "baptism.csv"), "utf8"));
}

/** Column lookups by name so a header reorder cannot silently break an index. */
function cols(rows: string[][]) {
  const header = rows[0]!;
  const body = rows.slice(1);
  const at = (name: string) => header.indexOf(name);
  return {
    events: () => body.map((r) => r[at("event")]),
    filter: (event: string) => body.filter((r) => r[at("event")] === event),
    idx: at,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the raw layer records the last grouped person, not just phase 0..n-1", () => {
  it("keeps the last person's baptism time when the session auto-finishes", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start(); // testimony, person 1
    await sleep(5);
    baptismTimerService.next(); // person 1 testimony done, person 2 testimony starts
    await sleep(5);
    baptismTimerService.startBaptisms(); // person 2 testimony finalized, section armed
    baptismTimerService.advance(); // "first person in" — starts person 1's baptism clock
    await sleep(5);
    baptismTimerService.next(); // person 1 baptized, person 2's baptism clock starts
    await sleep(9);
    const finished = baptismTimerService.next(); // person 2 (LAST) baptized — auto-finishes

    assert.equal(finished.phase, "idle", "the session closed itself after the last person");
    assert.equal(finished.people.length, 2);
    assert.ok(finished.people[0]!.baptizeMs > 0, "person 1's baptism actually ran a clock");
    assert.ok(finished.people[1]!.baptizeMs > 0, "person 2's baptism actually ran a clock");

    const rows = await baptismRows(ctx);
    const c = cols(rows);

    // An ordered list, not a count: a count cannot tell an added row and a
    // removed row apart from no change (CLAUDE.md's exact-list rule). One row
    // per operator action: reset, start, testimony-end (person 1's, via
    // next()), baptisms-armed (person 2's testimony folded into arming),
    // baptisms-start, person-complete x2, finish.
    assert.deepEqual(c.events(), [
      "reset",
      "start",
      "testimony-end",
      "baptisms-armed",
      "baptisms-start",
      "person-complete",
      "person-complete",
      "finish",
    ]);

    // The ordered baptismIndex list, and EVERY row's segmentMs checked against
    // memory — not `.find(r => baptismIndexCol === "1")` picking out just the
    // last row. `.find` alone survives the off-by-one that moves this emit
    // after baptismIndex advances: that mutation writes baptismIndex 1, 2 (not
    // 0, 1) for a 2-person session, and `.find("1")` still locates a row —
    // the WRONG one — while a `.find("0")` or a full ordered-list assertion
    // does not.
    const personCompleteRows = c.filter("person-complete");
    assert.deepEqual(
      personCompleteRows.map((r) => r[c.idx("baptismIndex")]),
      ["0", "1"],
      "one person-complete row per baptismIndex, in order, none skipped or duplicated",
    );
    personCompleteRows.forEach((row, i) => {
      assert.equal(
        Number(row[c.idx("segmentMs")]),
        Math.round(finished.people[i]!.baptizeMs),
        `row ${i}'s segmentMs must match finished.people[${i}].baptizeMs, not just the last row's`,
      );
    });
  });

  // C2: the person whose testimony ends by ARMING (never by their own next()
  // press) must not lose that time to the free-text detail column.
  it("carries the folded last testimony's time in the baptisms-armed row, not just detail", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start(); // testimony, person 1 (the only person here)
    await sleep(5);
    const armed = baptismTimerService.startBaptisms(); // folds person 1's testimony, arms
    const soleTestimonyMs = armed.people[0]!.testimonyMs;
    assert.ok(soleTestimonyMs > 0, "a real clock ran for the only person's testimony");

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), ["reset", "start", "baptisms-armed"]);
    assert.equal(
      Number(c.filter("baptisms-armed")[0]![c.idx("segmentMs")]),
      Math.round(soleTestimonyMs),
      "the folded testimony's time reaches the structured segmentMs column",
    );
  });

  // I3, proven rather than merely commented: personNumber freezes once the
  // baptism section arms — it is NOT the field a replay can key a grouped row
  // on. baptismIndex is (already proven above).
  it("freezes personNumber at the section total for every baptism-phase row", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(2);
    baptismTimerService.next(); // person 1 testimony done, person 2 starts
    await sleep(2);
    baptismTimerService.startBaptisms();
    baptismTimerService.advance();
    await sleep(2);
    baptismTimerService.next(); // person 1 baptized
    await sleep(2);
    baptismTimerService.next(); // person 2 (last) baptized, auto-finishes

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), [
      "reset",
      "start",
      "testimony-end",
      "baptisms-armed",
      "baptisms-start",
      "person-complete",
      "person-complete",
      "finish",
    ]);
    assert.deepEqual(
      c.filter("person-complete").map((r) => r[c.idx("personNumber")]),
      ["2", "2"],
      "both person-complete rows share personNumber=2 — a replay must not use it to tell them apart",
    );
  });
});

describe("finish() is the only terminator for a per-person session, and must record its last person", () => {
  it("records person 2's baptism when Finish closes it, not just person 1's via next()", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");

    baptismTimerService.start(); // person 1 testimony
    await sleep(5);
    baptismTimerService.baptized(); // person 1 baptism
    await sleep(5);
    baptismTimerService.next(); // person 1 done, person 2 testimony starts
    await sleep(5);
    baptismTimerService.baptized(); // person 2 baptism
    await sleep(9);
    const finished = baptismTimerService.finish(); // Finish closes person 2 — the ONLY way this ends

    assert.equal(finished.phase, "idle");
    assert.equal(finished.people.length, 2);
    assert.ok(finished.people[1]!.baptizeMs > 0, "person 2 actually ran a baptism clock before Finish closed it");

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    // The path this round's N1 exists for: deleting baptized()'s testimony-end
    // emit is invisible to `c.filter("person-complete").length` (unaffected)
    // and to `c.filter("testimony-end").length` alone if something else also
    // emits that event — only the full ordered list pins every action to its
    // event, in order.
    assert.deepEqual(c.events(), [
      "reset",
      "start",
      "testimony-end", // baptized(): person 1 testimony → baptism
      "person-complete", // next(): person 1's baptism closes, person 2 testimony starts
      "testimony-end", // baptized(): person 2 testimony → baptism
      "person-complete", // finish(): person 2's baptism closes — the only terminator
      "finish",
    ]);
    const personCompleteRows = c.filter("person-complete");
    assert.equal(
      Number(personCompleteRows[1]![c.idx("segmentMs")]),
      Math.round(finished.people[1]!.baptizeMs),
      "finish()'s row carries person 2's real baptizeMs, not a lost/zero value",
    );
  });

  it("records the in-progress testimony when Finish closes it before any baptism", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");

    baptismTimerService.start(); // person 1 testimony, never baptized
    const finished = baptismTimerService.finish();
    assert.equal(finished.people.length, 1);
    assert.equal(finished.people[0]!.baptizeMs, 0, "never reached baptism");

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), ["reset", "start", "testimony-end", "finish"]);
  });
});

describe("finish() mid-baptism in grouped mode also records the closing person", () => {
  it("writes a person-complete row when Finish closes a grouped baptism early", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(2);
    baptismTimerService.next(); // person 1 testimony done, person 2 testimony starts
    await sleep(2);
    baptismTimerService.startBaptisms();
    baptismTimerService.advance(); // person 1's baptism clock starts
    await sleep(5);
    const finished = baptismTimerService.finish(); // Finish closes person 1 early — person 2 never baptized

    assert.equal(finished.people.length, 2);
    assert.ok(finished.people[0]!.baptizeMs > 0);

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), ["reset", "start", "testimony-end", "baptisms-armed", "baptisms-start", "person-complete", "finish"]);
    const personCompleteRows = c.filter("person-complete");
    assert.equal(personCompleteRows[0]![c.idx("baptismIndex")], "0", "only person 0 was ever baptized");
    assert.equal(Number(personCompleteRows[0]![c.idx("segmentMs")]), Math.round(finished.people[0]!.baptizeMs));
  });

  // A1: no test anywhere in the repo drove this path before. finish()'s
  // per-person testimony branch is covered (line ~446); its grouped sibling
  // (line ~451) is not — an ordinary Sunday sequence (Start Baptisms never
  // pressed; the operator hits Finish instead, baptisms cancelled) closes the
  // person currently mid-testimony with no row anywhere but `finish`'s own
  // `people=N` detail, which carries no per-person time at all.
  it("records the in-progress testimony when Finish cancels the baptisms in grouped mode", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start(); // person 1 testimony
    await sleep(5);
    baptismTimerService.next(); // person 1 testimony done, person 2 testimony starts
    await sleep(5);
    const finished = baptismTimerService.finish(); // Finish instead of Start Baptisms — cancels the baptism section

    assert.equal(finished.people.length, 2);
    assert.ok(finished.people[1]!.testimonyMs > 0, "person 2's testimony actually ran a clock");

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), ["reset", "start", "testimony-end", "testimony-end", "finish"]);
    const testimonyEndRows = c.filter("testimony-end");
    assert.equal(
      Number(testimonyEndRows[1]![c.idx("segmentMs")]),
      Math.round(finished.people[1]!.testimonyMs),
      "person 2's testimony time reaches a structured column, not just finish's people=N detail",
    );
  });
});

// N3: neither next() nor finish() may write a person-complete row for a
// person closed while the baptism section is still ARMED — nobody's clock has
// ever run for them (segmentStartedAt is null, segmentAccumMs is 0), so
// elapsedMs() reads 0 the same as it would for a genuine instant baptism. A
// replay reading "a person-complete row exists" as "this person was baptized"
// would invent one that never happened. Nothing is lost: the person already
// has a testimony-end row (or was folded into baptisms-armed) correctly
// carrying baptizeMs: 0.
describe("closing a person while still armed writes no person-complete row for them", () => {
  it("finish() while armed writes no person-complete — Finish pressed before anyone steps up", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(2);
    baptismTimerService.next(); // person 1 testimony done, person 2 testimony starts
    await sleep(2);
    const armed = baptismTimerService.startBaptisms(); // folds person 2's testimony, arms
    assert.equal(armed.armed, true, "nobody has pressed yet");
    const finished = baptismTimerService.finish(); // Finish while still armed — nobody's clock ever ran

    assert.equal(finished.people.length, 2);
    assert.equal(finished.people[0]!.baptizeMs, 0, "person 1 was never baptized");
    assert.equal(finished.people[1]!.baptizeMs, 0, "person 2 was never baptized");

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(
      c.events(),
      ["reset", "start", "testimony-end", "baptisms-armed", "finish"],
      "no person-complete row for either person — neither was ever baptized",
    );
  });

  it("next() while armed (bypassing advance(), a documented route) writes no person-complete for the skipped person", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(2);
    baptismTimerService.next(); // person 1 testimony done, person 2 testimony starts
    await sleep(2);
    const armed = baptismTimerService.startBaptisms(); // folds person 2's testimony, arms
    assert.equal(armed.armed, true);
    baptismTimerService.next(); // DIRECTLY, bypassing advance() — closes person 0 (index 0) with no clock ever run
    await sleep(5);
    const finished = baptismTimerService.next(); // person index 1's clock DID run — closes it for real, auto-finishes

    assert.equal(finished.people.length, 2);
    assert.equal(finished.people[0]!.baptizeMs, 0, "person at index 0 was skipped while armed, never baptized");
    assert.ok(finished.people[1]!.baptizeMs > 0, "person at index 1 ran a real clock");

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(
      c.events(),
      ["reset", "start", "testimony-end", "baptisms-armed", "person-complete", "finish"],
      "exactly one person-complete row — for the person who actually ran a clock",
    );
    const personCompleteRows = c.filter("person-complete");
    assert.equal(
      personCompleteRows[0]![c.idx("baptismIndex")],
      "1",
      "the row names index 1 (the real baptism), never index 0 (the skipped one)",
    );
    assert.equal(Number(personCompleteRows[0]![c.idx("segmentMs")]), Math.round(finished.people[1]!.baptizeMs));
  });
});

// A2: the `undo` emit had no test at all, and it is the ONLY thing that tells
// a replay `person-complete` is not a unique-per-person event — undoing a
// baptism and redoing it writes a SECOND person-complete row for the same
// baptismIndex, and the correct value is the LAST one, not the first. Without
// a marker between them, a replay counting person-complete rows reports three
// baptisms for two people with no way to notice.
describe("undoing and redoing a baptism writes a second person-complete row, and the last one wins", () => {
  it("the LAST person-complete row for a re-baptized index carries the real baptizeMs", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start();
    await sleep(2);
    baptismTimerService.next(); // person 1 testimony done, person 2 testimony starts
    await sleep(2);
    baptismTimerService.startBaptisms();
    baptismTimerService.advance(); // person 1's baptism clock starts
    await sleep(5);
    baptismTimerService.next(); // person 1 (index 0) baptized — a mis-tap, too early
    baptismTimerService.undo(); // back to index 0, clock restarted
    await sleep(9); // the REAL baptism runs longer
    baptismTimerService.next(); // person 1 (index 0) baptized again — the real one
    await sleep(5);
    const finished = baptismTimerService.next(); // person 2 (index 1) baptized — auto-finishes

    assert.equal(finished.people.length, 2);
    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), [
      "reset",
      "start",
      "testimony-end",
      "baptisms-armed",
      "baptisms-start",
      "person-complete",
      "undo",
      "person-complete",
      "person-complete",
      "finish",
    ]);
    const personCompleteRows = c.filter("person-complete");
    assert.deepEqual(
      personCompleteRows.map((r) => r[c.idx("baptismIndex")]),
      ["0", "0", "1"],
      "index 0 appears twice (the undone attempt, then the real one), then index 1 once",
    );
    assert.equal(
      Number(personCompleteRows[1]![c.idx("segmentMs")]),
      Math.round(finished.people[0]!.baptizeMs),
      "the LAST index-0 row is the authoritative one, not the first (too-early) attempt",
    );
    assert.notEqual(
      personCompleteRows[0]![c.idx("segmentMs")],
      personCompleteRows[1]![c.idx("segmentMs")],
      "the two attempts must have genuinely different durations, or last-wins is unproven",
    );
  });
});

// A3: undo() out of an armed grouped baptism section must pop the person
// startBaptisms() folded in when it armed, or a later re-arm appends a SECOND
// entry for the same person. A one-person service then finishes as two — the
// headline number of this whole feature — and arming on the wrong song,
// undoing, then re-arming when the right song goes live is an ordinary
// Sunday sequence, not an edge case.
describe("undoing out of an armed baptism section does not duplicate the folded person", () => {
  it("arm, undo, re-arm leaves exactly one person, not two", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start(); // the only person, testimony
    await sleep(3);
    const armed = baptismTimerService.startBaptisms(); // folds the only person, arms — wrong song
    assert.equal(armed.people.length, 1, "sanity: exactly one person after the first arm");

    const undone = baptismTimerService.undo(); // back to testimony — must pop the fold, not leave it
    assert.equal(undone.phase, "testimony");
    assert.equal(
      undone.people.length,
      0,
      "the folded person is popped back into the in-progress testimony, not left as a completed entry",
    );

    await sleep(4); // testimony continues running
    const rearmed = baptismTimerService.startBaptisms(); // right song — arm again
    assert.equal(
      rearmed.people.length,
      1,
      "re-arming must fold the SAME person once, not add a second entry beside the one undo left behind",
    );

    const finished = baptismTimerService.finish();
    assert.equal(finished.people.length, 1, "a one-person service must finish as one person, not two");

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), ["reset", "start", "baptisms-armed", "undo", "baptisms-armed", "finish"]);
  });
});

// I2: two of the three off-by-one sites this task fixed (per-person
// person-complete, grouped-testimony testimony-end) had no guard at all — the
// grouped-baptism site was covered only indirectly via baptismIndex above.
describe("personNumber on a row names the person that action just completed, not the next one", () => {
  it("per-person: person-complete's personNumber is the person just baptized", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");

    baptismTimerService.start(); // person 1
    baptismTimerService.baptized();
    await sleep(2);
    baptismTimerService.next(); // person 1 complete, person 2 testimony starts

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), ["reset", "start", "testimony-end", "person-complete"]);
    const personCompleteRows = c.filter("person-complete");
    assert.equal(
      personCompleteRows[0]![c.idx("personNumber")],
      "1",
      "person 1 was baptized — the row must not already say 2",
    );
  });

  it("grouped: each testimony-end row's personNumber is the person whose testimony just ended", async () => {
    const ctx = freshCtx();
    openService(ctx);
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");

    baptismTimerService.start(); // person 1 testimony
    await sleep(2);
    baptismTimerService.next(); // person 1 done, person 2 starts
    await sleep(2);
    baptismTimerService.next(); // person 2 done, person 3 starts
    // person 3's testimony is left running — folded into arming elsewhere, not
    // relevant to this guard.

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    assert.deepEqual(c.events(), ["reset", "start", "testimony-end", "testimony-end"]);
    const testimonyEndRows = c.filter("testimony-end");
    assert.deepEqual(
      testimonyEndRows.map((r) => r[c.idx("personNumber")]),
      ["1", "2"],
      "each row names the person who just finished, not the one who started next",
    );
  });
});

describe("the raw emit never throws back into the timer", () => {
  beforeEach(() => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
  });

  it("survives the archive throwing on write", () => {
    openService(freshCtx());
    const original = sampleArchive.recordBaptism;
    (sampleArchive as unknown as { recordBaptism: typeof sampleArchive.recordBaptism }).recordBaptism = () => {
      throw new Error("disk full");
    };
    try {
      const s = baptismTimerService.start();
      assert.equal(s.phase, "testimony", "the timer's own state still advanced despite the archive throwing");
    } finally {
      (sampleArchive as unknown as { recordBaptism: typeof sampleArchive.recordBaptism }).recordBaptism = original;
    }
  });
});

describe("the no-service warning logs once per session, not once per press", () => {
  beforeEach(() => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
  });

  it("warns once across several actions with no service open", async () => {
    rec().current = null; // no open service for the whole session
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[baptism] raw:")) warnings.push(args);
    };
    try {
      baptismTimerService.start();
      await sleep(2);
      baptismTimerService.next();
      baptismTimerService.pause();
      baptismTimerService.resume();
      assert.equal(warnings.length, 1, "one warning for the whole session, not one per press");
    } finally {
      console.warn = original;
    }

    // A NEW session gets its own warning — the latch is per-session, not global.
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    const warnings2: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[baptism] raw:")) warnings2.push(args);
    };
    try {
      baptismTimerService.start();
      baptismTimerService.pause();
      assert.equal(warnings2.length, 1, "a fresh session re-arms its own one-time warning");
    } finally {
      console.warn = original;
    }
  });
});
