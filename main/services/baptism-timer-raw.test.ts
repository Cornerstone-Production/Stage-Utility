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
// Also covers: startBaptisms() folding the final testimony into the arming
// row without losing its testimonyMs to a structured column; the raw layer
// never throwing back into the timer; the "no service open" latch logging
// once per session; and that personNumber — not baptismIndex — is the field
// that freezes in grouped mode, so a replay must not key a grouped row on it.
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
    await sleep(5);
    const finished = baptismTimerService.next(); // person 2 (LAST) baptized — auto-finishes

    assert.equal(finished.phase, "idle", "the session closed itself after the last person");
    assert.equal(finished.people.length, 2);
    const lastBaptizeMs = finished.people[1]!.baptizeMs;
    assert.ok(lastBaptizeMs > 0, "the last person's baptism actually ran a clock");

    const rows = await baptismRows(ctx);
    const c = cols(rows);

    const personCompleteRows = c.filter("person-complete");
    assert.equal(personCompleteRows.length, 2, "one person-complete row per person, including the last");

    const baptismIndexCol = c.idx("baptismIndex");
    const segmentCol = c.idx("segmentMs");
    const lastRow = personCompleteRows.find((r) => r[baptismIndexCol] === "1");
    assert.ok(lastRow, "the last person (baptismIndex 1) has its own person-complete row");
    assert.equal(
      Number(lastRow![segmentCol]),
      Math.round(lastBaptizeMs),
      "the row carries the same baptizeMs the finished session recorded — not 0",
    );

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
    const armedRows = c.filter("baptisms-armed");
    assert.equal(armedRows.length, 1);
    assert.equal(
      Number(armedRows[0]![c.idx("segmentMs")]),
      Math.round(soleTestimonyMs),
      "the folded testimony's time reaches the structured segmentMs column",
    );
  });

  // I3, proven rather than merely commented: personNumber freezes once the
  // baptism section arms — it is NOT the field a replay can key a grouped row
  // on. baptismIndex is (already proven by the row above via baptismIndexCol).
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
    const personCompletePersonNumbers = c.filter("person-complete").map((r) => r[c.idx("personNumber")]);
    assert.deepEqual(
      personCompletePersonNumbers,
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
    await sleep(5);
    const finished = baptismTimerService.finish(); // Finish closes person 2 — the ONLY way this ends

    assert.equal(finished.phase, "idle");
    assert.equal(finished.people.length, 2);
    const person2BaptizeMs = finished.people[1]!.baptizeMs;
    assert.ok(person2BaptizeMs > 0, "person 2 actually ran a baptism clock before Finish closed it");

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    const personCompleteRows = c.filter("person-complete");
    assert.equal(personCompleteRows.length, 2, "person 1 (via next()) AND person 2 (via finish()) each get a row");
    assert.equal(
      Number(personCompleteRows[1]![c.idx("segmentMs")]),
      Math.round(person2BaptizeMs),
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
    assert.equal(c.filter("testimony-end").length, 1, "finish() mid-testimony still records a testimony-end row");
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
    const person1BaptizeMs = finished.people[0]!.baptizeMs;
    assert.ok(person1BaptizeMs > 0);

    const rows = await baptismRows(ctx);
    const c = cols(rows);
    const personCompleteRows = c.filter("person-complete");
    assert.equal(personCompleteRows.length, 1, "only person 1 was ever baptized — one row, not zero");
    assert.equal(Number(personCompleteRows[0]![c.idx("segmentMs")]), Math.round(person1BaptizeMs));
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
    const personCompleteRows = c.filter("person-complete");
    assert.equal(personCompleteRows.length, 1);
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
