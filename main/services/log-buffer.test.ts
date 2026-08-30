// The incremental read behind /log's poll.
//
// The viewer refetched the whole ring buffer every two seconds — 140 KB on a
// server that had only just booted, ~1.5 MB projected at the 10,000-line cap,
// per open tab. `?since=` fixes that, and the only way it can go wrong is by
// LOSING lines: hand back an append when the buffer has rolled past what the
// client last saw and the page draws a continuous log with a hole in it, which
// is worse than the cost it was replacing.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { addLogLine, getLevelCounts, getLogLines, getLogSince } from "./log-buffer.js";

/** The buffer's own cap, restated so the eviction test can actually reach it. */
const MAX = 10_000;

describe("getLogSince", () => {
  test("no cursor means everything, and says to replace rather than append", () => {
    addLogLine("log", "first");
    const all = getLogSince(null);
    assert.equal(all.reset, true);
    assert.ok(all.lines.length >= 1);
    assert.equal(all.latestSeq, all.lines[all.lines.length - 1].seq);
  });

  test("a cursor returns only what arrived after it", () => {
    const cursor = getLogSince(null).latestSeq;
    addLogLine("log", "after the cursor A");
    addLogLine("log", "after the cursor B");
    const slice = getLogSince(cursor);
    assert.equal(slice.reset, false, "nothing was dropped, so this is an append");
    assert.deepEqual(
      slice.lines.map((l) => l.msg),
      ["after the cursor A", "after the cursor B"],
    );
  });

  test("a cursor already caught up returns nothing at all", () => {
    const cursor = getLogSince(null).latestSeq;
    const slice = getLogSince(cursor);
    assert.deepEqual(slice.lines, [], "a quiet server must move no lines");
    assert.equal(slice.reset, false);
    assert.equal(slice.latestSeq, cursor);
  });

  test("every line in the buffer has a unique, strictly ascending seq", () => {
    // Not "the two entry points agree" asserted by writing one of each: the test
    // runner installs its own console before a test body runs, so a console.log
    // here proves nothing about the patched console the server has. This asserts
    // the property that actually matters to a client — whatever produced a line,
    // its number is unique and ordered — over the whole buffer.
    addLogLine("warn", "one");
    addLogLine("error", "two");
    const seqs = getLogLines().map((l) => l.seq);
    assert.ok(seqs.length > 2);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} did not advance past ${seqs[i - 1]}`);
    }
    assert.equal(new Set(seqs).size, seqs.length, "a repeated seq would make ?since= skip a line");
  });

  test("a nonsense cursor is treated as no cursor rather than trusted", () => {
    for (const bad of [NaN, Infinity, -1]) {
      assert.equal(getLogSince(bad).reset, true, `${bad} must not be read as a position`);
    }
  });

  test("a cursor the buffer has rolled past forces a replace, not a silent hole", () => {
    // Reached by genuinely overflowing the ring rather than by handing in a
    // number that merely looks old — the branch under test is the comparison
    // against the OLDEST RETAINED seq, and a negative cursor would exit through
    // the validation branch above it and pass for the wrong reason.
    const stale = getLogSince(null).latestSeq;
    for (let i = 0; i < MAX + 50; i++) addLogLine("log", `filler ${i}`);
    const oldest = getLogLines()[0].seq;
    assert.ok(oldest > stale + 1, "the cursor must really have been evicted for this to test anything");

    const slice = getLogSince(stale);
    assert.equal(slice.reset, true, "appending here would leave a gap the page could not see");
    assert.equal(slice.lines.length, getLogLines().length);

    // And the boundary still appends: a cursor whose very next line survives is
    // provably gap-free, so it must NOT be forced into a full replace.
    assert.equal(getLogSince(oldest - 1).reset, false);
  });
});

describe("getLevelCounts", () => {
  test("counts warnings and errors over the whole buffer", () => {
    const before = getLevelCounts();
    addLogLine("warn", "a warning");
    addLogLine("error", "an error");
    addLogLine("error", "another error");
    addLogLine("log", "not counted");
    addLogLine("info", "also not counted");
    const after = getLevelCounts();
    assert.equal(after.warnings, before.warnings + 1);
    assert.equal(after.errors, before.errors + 2);
  });
});
