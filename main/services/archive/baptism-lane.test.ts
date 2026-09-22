// baptism-lane.test.ts — the lane rules, one fixture per emitter behaviour.
//
// Hand-written rows can only assert what their author believed the emitter
// writes; the guard that matters is baptism-lane-roundtrip.test.ts, which drives
// the real timer and derives the lane from the rows it actually wrote. This file
// names each rule, so a failure points at the rule rather than at a session, and
// covers the shapes a driven session cannot produce on demand: a lost finish
// row, a damaged stamp, rows that belong to no session.
//
// The fixtures past the first describe were transcribed from driven runs of the
// real baptismTimerService, times rounded to seconds. The first describe is the
// task brief's own; its pause fixture omits the `testimony-end` that a real
// per-person finish() writes before `finish`, which the lane closes the same
// span on either way.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baptismLaneSpans, type BaptismSpan } from "./baptism-lane.js";
import type { BaptismRow } from "./rebuild-baptism.js";

/** t is seconds after 11:00:00Z. */
const row = (t: number, over: Partial<BaptismRow>): BaptismRow => ({
  at: new Date(Date.UTC(2026, 8, 27, 11, 0, t)).toISOString(),
  event: "", mode: "grouped", phase: "", personNumber: "0", baptismIndex: "0",
  segmentMs: "0", itemId: "", item: "", detail: "",
  ...over,
});
const sec = (s: BaptismSpan) =>
  s.endedAt === null ? null : (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000;

describe("baptismLaneSpans", () => {
  it("leaves the armed stretch as a gap, owned by nobody", () => {
    const spans = baptismLaneSpans([
      row(0,   { event: "start", phase: "testimony", personNumber: "1" }),
      row(100, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "100000" }),
      row(160, { event: "baptisms-start", phase: "baptism" }),
      row(200, { event: "person-complete", phase: "baptism", baptismIndex: "0", segmentMs: "40000" }),
      row(201, { event: "finish", phase: "idle" }),
    ]);
    assert.deepEqual(spans.map((s) => [s.kind, s.person, sec(s)]), [
      ["testimony", 1, 100],
      ["baptism", 1, 40],
    ]);
    // 100s..160s belongs to no span: the band's intro.
    assert.equal(Date.parse(spans[1].startedAt) - Date.parse(spans[0].endedAt as string), 60_000);
  });

  it("names a grouped baptism by baptismIndex, not the frozen personNumber", () => {
    const spans = baptismLaneSpans([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(10, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "10000" }),
      row(25, { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(30, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "5000" }),
      row(40, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "10000" }),
      row(41, { event: "finish", phase: "idle", personNumber: "2", baptismIndex: "1" }),
    ]);
    assert.deepEqual(spans.filter((s) => s.kind === "baptism").map((s) => s.person), [1, 2]);
  });

  it("splits a span at a pause and resumes it as the same person", () => {
    const spans = baptismLaneSpans([
      row(0,  { event: "start", mode: "per-person", phase: "testimony", personNumber: "1" }),
      row(30, { event: "pause", mode: "per-person", phase: "testimony", personNumber: "1", segmentMs: "30000" }),
      row(90, { event: "resume", mode: "per-person", phase: "testimony", personNumber: "1", segmentMs: "30000" }),
      row(110,{ event: "finish", mode: "per-person", phase: "idle", personNumber: "1" }),
    ]);
    assert.deepEqual(spans.map((s) => [s.kind, s.person, sec(s)]), [
      ["testimony", 1, 30],
      ["testimony", 1, 20],
    ]);
  });

  it("leaves the last span open while the session runs", () => {
    const spans = baptismLaneSpans([row(0, { event: "start", phase: "testimony", personNumber: "1" })]);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].endedAt, null);
  });
});

/** Seconds after 11:00:00Z, or null for a span still running. */
const off = (iso: string | null) => (iso === null ? null : (Date.parse(iso) - Date.UTC(2026, 8, 27, 11, 0, 0)) / 1000);
/** Every span as [kind, person, start, end], so a fixture pins positions, not just lengths. */
const lane = (rows: BaptismRow[]) =>
  baptismLaneSpans(rows).map((s) => [s.kind, s.person, off(s.startedAt), off(s.endedAt)]);

/** Silence the one [baptism-lane] line a damaged fixture prints, and hand back
 *  what it said so the test can assert the operator has something to read. */
function captureWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[baptism-lane]")) warnings.push(args[0]);
    else original(...args);
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("baptismLaneSpans: the press that ends a session opens nothing", () => {
  it("draws no baptism for the person a grouped finish left unbaptized", () => {
    // finish() pressed mid-baptism: person-complete for index 0, then finish.
    // Person 2 exists — the person count says someone is left — but was never
    // baptized, so a span opened here would be a baptism that did not happen.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(21, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "21000" }),
      row(43, { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "22000" }),
      row(43, { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(63, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "20000" }),
      row(63, { event: "finish", phase: "idle", personNumber: "2", detail: "people=2" }),
    ]), [
      ["testimony", 1, 0, 21],
      ["testimony", 2, 21, 43],
      ["baptism", 1, 43, 63],
    ]);
  });

  it("draws no testimony for a third person when a grouped finish closes the second", () => {
    // Two testimony-end rows: next()'s, then finish()'s own. The second is
    // followed by finish and so starts nobody.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(22, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "22000" }),
      row(44, { event: "testimony-end", phase: "testimony", personNumber: "2", segmentMs: "22000" }),
      row(44, { event: "finish", phase: "idle", personNumber: "2", detail: "people=2" }),
    ]), [
      ["testimony", 1, 0, 22],
      ["testimony", 2, 22, 44],
    ]);
  });

  it("draws no next testimony after a per-person finish closes a baptism", () => {
    // Per-person next() always starts another testimony — but this
    // person-complete is finish()'s, which does not.
    assert.deepEqual(lane([
      row(0,  { event: "start", mode: "per-person", phase: "testimony", personNumber: "1" }),
      row(30, { event: "testimony-end", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "30000" }),
      row(50, { event: "person-complete", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(50, { event: "finish", mode: "per-person", phase: "idle", personNumber: "1", detail: "people=1" }),
    ]), [
      ["testimony", 1, 0, 30],
      ["baptism", 1, 30, 50],
    ]);
  });

  it("starts no per-person baptism at finish()'s testimony-end, even when the finish row was lost", () => {
    // phase=testimony is what says this testimony-end is finish()'s. baptized()
    // writes its own at phase=baptism, having already moved on.
    assert.deepEqual(lane([
      row(0,  { event: "start", mode: "per-person", phase: "testimony", personNumber: "1" }),
      row(30, { event: "testimony-end", mode: "per-person", phase: "testimony", personNumber: "1", segmentMs: "30000" }),
    ]), [
      ["testimony", 1, 0, 30],
    ]);
  });

  it("opens no grouped baptism past the last person, even when the finish row was lost", () => {
    // The person count, not the finish lookahead, is what stops this one: a file
    // cut off after the last person-complete has no finish row to look at.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(10, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "10000" }),
      row(25, { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(30, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "5000" }),
      row(40, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "10000" }),
    ]), [
      ["testimony", 1, 0, 10],
      ["testimony", 2, 10, 20],
      ["baptism", 1, 25, 30],
      ["baptism", 2, 30, 40],
    ]);
  });
});

describe("baptismLaneSpans: undo", () => {
  it("grouped, back into the testimony next() closed: resumed, the next testimony a gap", () => {
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(21, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "21000" }),
      row(43, { event: "undo", phase: "testimony", personNumber: "1", detail: "from testimony" }),
      row(64, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "42000" }),
      row(64, { event: "finish", phase: "idle", personNumber: "1" }),
    ]), [
      // Person 1's first 21s still count: undo resumes from what they banked.
      ["testimony", 1, 0, 21],
      ["testimony", 1, 43, 64],
    ]);
  });

  it("grouped, back out of the baptisms: the folded testimony resumes and the baptism is dropped", () => {
    assert.deepEqual(lane([
      row(0,   { event: "start", phase: "testimony", personNumber: "1" }),
      row(22,  { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "22000" }),
      row(44,  { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "22000" }),
      row(44,  { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(67,  { event: "undo", phase: "testimony", personNumber: "2", baptismIndex: "0", detail: "from baptism" }),
      row(88,  { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "43000" }),
      row(88,  { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(110, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "22000" }),
      row(130, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "20000" }),
      row(130, { event: "finish", phase: "idle", personNumber: "2", baptismIndex: "1" }),
    ]), [
      ["testimony", 1, 0, 22],
      ["testimony", 2, 22, 44],
      ["testimony", 2, 67, 88],
      ["baptism", 1, 88, 110],
      ["baptism", 2, 110, 130],
    ]);
  });

  it("grouped, within the baptisms: the undone baptism is re-timed from the undo, not resumed", () => {
    // undo() at baptismIndex 1 restarts index 0 at zero. Its first attempt, and
    // the stretch index 1 ran before the undo, are both time nobody counted.
    assert.deepEqual(lane([
      row(0,   { event: "start", phase: "testimony", personNumber: "1" }),
      row(20,  { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "20000" }),
      row(40,  { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "20000" }),
      row(40,  { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(60,  { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "20000" }),
      row(70,  { event: "undo", phase: "baptism", personNumber: "2", baptismIndex: "0", detail: "from baptism" }),
      row(110, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "40000" }),
      row(130, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "20000" }),
      row(130, { event: "finish", phase: "idle", personNumber: "2", baptismIndex: "1" }),
    ]), [
      ["testimony", 1, 0, 20],
      ["testimony", 2, 20, 40],
      ["baptism", 1, 70, 110],
      ["baptism", 2, 110, 130],
    ]);
  });

  it("grouped, un-finishing a closed session re-times its last baptism", () => {
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(25, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(45, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "20000" }),
      row(45, { event: "finish", phase: "idle", personNumber: "1" }),
      row(45, { event: "undo", phase: "baptism", personNumber: "1", baptismIndex: "0", detail: "from idle" }),
      row(68, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "23000" }),
      row(68, { event: "finish", phase: "idle", personNumber: "1" }),
    ]), [
      ["testimony", 1, 0, 20],
      ["baptism", 1, 45, 68],
    ]);
  });

  it("counts out the person a testimony-side undo took back, so a lost finish opens no baptism", () => {
    // Arm, undo, re-arm folds the same person twice. Without the undo's pop the
    // count reads two, and the last person-complete opens a baptism for a
    // second person who does not exist — visible once the finish row is gone.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(25, { event: "undo", phase: "testimony", personNumber: "1", detail: "from baptism" }),
      row(40, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "35000" }),
      row(45, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(50, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
    ]), [
      ["testimony", 1, 0, 20],
      ["testimony", 1, 25, 40],
      ["baptism", 1, 45, 50],
    ]);
  });

  it("leaves nothing armed after an undo out of the armed section: a later pause is only a pause", () => {
    // Were the section still armed, this pause would read as the first row
    // after a silent baptism clock and invent one.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(25, { event: "undo", phase: "testimony", personNumber: "1", detail: "from baptism" }),
      row(35, { event: "pause", phase: "testimony", personNumber: "1", segmentMs: "30000" }),
      row(45, { event: "resume", phase: "testimony", personNumber: "1", segmentMs: "30000" }),
      row(55, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "40000" }),
      row(60, { event: "finish", phase: "idle", personNumber: "1" }),
    ]), [
      ["testimony", 1, 0, 20],
      ["testimony", 1, 25, 35],
      ["testimony", 1, 45, 55],
    ]);
  });

  it("per-person, Baptized taken back: the testimony resumes and the baptism is dropped", () => {
    assert.deepEqual(lane([
      row(0,  { event: "start", mode: "per-person", phase: "testimony", personNumber: "1" }),
      row(23, { event: "testimony-end", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "23000" }),
      row(35, { event: "undo", mode: "per-person", phase: "testimony", personNumber: "1", detail: "from baptism" }),
      row(57, { event: "testimony-end", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "45000" }),
      row(80, { event: "person-complete", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "23000" }),
      row(80, { event: "finish", mode: "per-person", phase: "idle", personNumber: "1" }),
    ]), [
      ["testimony", 1, 0, 23],
      ["testimony", 1, 35, 57],
      ["baptism", 1, 57, 80],
    ]);
  });

  it("per-person, Next taken back: the baptism is re-timed and the next testimony dropped", () => {
    // The same (phase=baptism, detail="from testimony") row that, read by its
    // detail in grouped mode, would mean something else entirely.
    assert.deepEqual(lane([
      row(0,   { event: "start", mode: "per-person", phase: "testimony", personNumber: "1" }),
      row(23,  { event: "testimony-end", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "23000" }),
      row(46,  { event: "person-complete", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "23000" }),
      row(67,  { event: "undo", mode: "per-person", phase: "baptism", personNumber: "1", detail: "from testimony" }),
      row(89,  { event: "person-complete", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "22000" }),
      row(112, { event: "testimony-end", mode: "per-person", phase: "baptism", personNumber: "2", segmentMs: "23000" }),
      row(131, { event: "person-complete", mode: "per-person", phase: "baptism", personNumber: "2", segmentMs: "19000" }),
      row(131, { event: "finish", mode: "per-person", phase: "idle", personNumber: "2" }),
    ]), [
      ["testimony", 1, 0, 23],
      ["baptism", 1, 67, 89],
      ["testimony", 2, 89, 112],
      ["baptism", 2, 112, 131],
    ]);
  });

  it("per-person, un-finishing a closed session re-times its last baptism", () => {
    assert.deepEqual(lane([
      row(0,  { event: "start", mode: "per-person", phase: "testimony", personNumber: "1" }),
      row(23, { event: "testimony-end", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "23000" }),
      row(42, { event: "person-complete", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "19000" }),
      row(42, { event: "finish", mode: "per-person", phase: "idle", personNumber: "1" }),
      row(42, { event: "undo", mode: "per-person", phase: "baptism", personNumber: "1", detail: "from idle" }),
      row(64, { event: "person-complete", mode: "per-person", phase: "baptism", personNumber: "1", segmentMs: "22000" }),
      row(64, { event: "finish", mode: "per-person", phase: "idle", personNumber: "1" }),
    ]), [
      ["testimony", 1, 0, 23],
      ["baptism", 1, 42, 64],
    ]);
  });
});

describe("baptismLaneSpans: session boundaries", () => {
  it("draws nothing for a session a reset cleared before it finished", () => {
    // reset() logs nothing, so that testimony is in no recorded session.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(21, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "21000" }),
      row(44, { event: "reset", phase: "idle" }),
      row(55, { event: "start", phase: "testimony", personNumber: "1" }),
      row(77, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "22000" }),
      row(77, { event: "finish", phase: "idle", personNumber: "1" }),
    ]), [
      ["testimony", 1, 55, 77],
    ]);
  });

  it("keeps what a finish logged when an undo reopened the session and a reset then cleared it", () => {
    // The store still holds the first finish's session: undo() and reset()
    // both leave it alone. The re-timed baptism after the undo is not in it.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(10, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "10000" }),
      row(15, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(20, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
      row(20, { event: "finish", phase: "idle", personNumber: "1" }),
      row(21, { event: "undo", phase: "baptism", personNumber: "1", baptismIndex: "0", detail: "from idle" }),
      row(30, { event: "reset", phase: "idle" }),
    ]), [
      ["testimony", 1, 0, 10],
      ["baptism", 1, 15, 20],
    ]);
  });

  it("draws nothing for a session whose finish never reached the file", () => {
    // start() only runs from idle, so a start with a session still underway
    // means that session's finish or reset was never written — the service
    // record closed under it, say. Nothing in the file says when it ended, and
    // the replay cannot log it either.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(10, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(30, { event: "start", phase: "testimony", personNumber: "1" }),
      row(40, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(40, { event: "finish", phase: "idle", personNumber: "1" }),
    ]), [
      ["testimony", 1, 30, 40],
    ]);
  });

  it("draws both of two sessions in one service, each numbered from person 1", () => {
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(10, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(10, { event: "finish", phase: "idle", personNumber: "1" }),
      row(30, { event: "start", mode: "per-person", phase: "testimony", personNumber: "1" }),
      row(40, { event: "testimony-end", mode: "per-person", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(40, { event: "finish", mode: "per-person", phase: "idle", personNumber: "1" }),
    ]), [
      ["testimony", 1, 0, 10],
      ["testimony", 1, 30, 40],
    ]);
  });

  it("draws nothing for rows before the first start, and takes the mode from the start row", () => {
    // A leading reset carries the previous session's mode (per-person here);
    // read off it, the per-person testimony-end at phase=baptism would open a
    // baptism instead of the grouped next testimony.
    assert.deepEqual(lane([
      row(0,  { event: "reset", mode: "per-person", phase: "idle" }),
      row(2,  { event: "person-complete", mode: "per-person", phase: "baptism", personNumber: "3", segmentMs: "5000" }),
      row(5,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(15, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
    ]), [
      ["testimony", 1, 5, 15],
      ["testimony", 2, 15, null],
    ]);
  });

  it("leaves nothing open while paused or armed", () => {
    const paused = lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(10, { event: "pause", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
    ]);
    assert.deepEqual(paused, [["testimony", 1, 0, 10]]);
    const armed = lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(10, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "10000" }),
    ]);
    assert.deepEqual(armed, [["testimony", 1, 0, 10]]);
  });

  it("orders rows by time before walking them", () => {
    const ordered = [
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(26, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
      row(26, { event: "finish", phase: "idle", personNumber: "1" }),
    ];
    const shuffled = [ordered[3]!, ordered[0]!, ordered[2]!, ordered[1]!, ordered[4]!];
    assert.deepEqual(baptismLaneSpans(shuffled), baptismLaneSpans(ordered));
  });
});

describe("baptismLaneSpans: the clock a direct next() starts while armed", () => {
  it("places it from the person-complete that ends it", () => {
    // next() while armed writes no row for person 1 (nobody's clock ran) and
    // none for person 2's clock starting. person-complete's segmentMs is that
    // clock's whole run: 87s - 32s puts its start at 55s.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(23, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "23000" }),
      row(43, { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "20000" }),
      row(87, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "32000" }),
      row(87, { event: "finish", phase: "idle", personNumber: "2", baptismIndex: "1" }),
    ]), [
      ["testimony", 1, 0, 23],
      ["testimony", 2, 23, 43],
      ["baptism", 2, 55, 87],
    ]);
  });

  it("places it from a pause, the first row after it, and resumes from there", () => {
    assert.deepEqual(lane([
      row(0,   { event: "start", phase: "testimony", personNumber: "1" }),
      row(20,  { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "20000" }),
      row(40,  { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "20000" }),
      row(70,  { event: "pause", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "20000" }),
      row(90,  { event: "resume", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "20000" }),
      row(100, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "30000" }),
      row(100, { event: "finish", phase: "idle", personNumber: "2", baptismIndex: "1" }),
    ]), [
      ["testimony", 1, 0, 20],
      ["testimony", 2, 20, 40],
      ["baptism", 2, 50, 70],
      ["baptism", 2, 90, 100],
    ]);
  });

  it("never places it before the section armed", () => {
    // A segmentMs longer than the time since arming cannot be the silent clock's
    // own run; the span is held to the arming row rather than overlapping the
    // testimony before it.
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(40, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "40000" }),
      row(50, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "90000" }),
    ]), [
      ["testimony", 1, 0, 40],
      ["baptism", 1, 40, 50],
    ]);
  });
});

describe("baptismLaneSpans: a damaged file says what it left out", () => {
  it("leaves out a span whose boundary cannot be placed, and logs it once", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      { ...row(10, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }), at: "not-a-date" },
      row(20, { event: "testimony-end", phase: "testimony", personNumber: "2", segmentMs: "10000" }),
      row(20, { event: "finish", phase: "idle", personNumber: "2" }),
    ];
    const { value, warnings } = captureWarnings(() => baptismLaneSpans(rows, "st1:p1:t1"));
    // Person 1 ended, and person 2 began, at a time the file cannot say.
    assert.deepEqual(value, []);
    assert.equal(warnings.length, 1, "an operator has one line to read, not one per span");
    assert.match(warnings[0]!, /st1:p1:t1: left out 2 span\(s\)/);
  });

  it("says nothing about an undamaged file", () => {
    const { warnings } = captureWarnings(() =>
      baptismLaneSpans([
        row(0,  { event: "reset", phase: "idle" }),
        row(1,  { event: "start", phase: "testimony", personNumber: "1" }),
        row(20, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "19000" }),
        row(20, { event: "finish", phase: "idle", personNumber: "1" }),
      ], "st1:p1:t1"),
    );
    assert.deepEqual(warnings, []);
  });

  it("ignores an event name this version never writes", () => {
    assert.deepEqual(lane([
      row(0,  { event: "start", phase: "testimony", personNumber: "1" }),
      row(5,  { event: "person-compl", phase: "baptism", personNumber: "1" }),
      row(10, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(10, { event: "finish", phase: "idle", personNumber: "1" }),
    ]), [
      ["testimony", 1, 0, 10],
    ]);
  });
});
