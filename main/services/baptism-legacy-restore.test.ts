// baptism-legacy-restore.test.ts — undo(), next(), advance() and finish() must
// all survive a record saved before `mode`/`baptismIndex` existed: restored
// (via init()'s grouped fallback) as grouped/baptism/baptismIndex 0 with an
// empty people list, since person 1's testimony then lived in
// pendingTestimonyMs, not in `people`.
//
// Split out of baptism-armed.test.ts (node:test gives each file its own fresh
// module graph): these four tests were the only ones in that file needing a
// long sleep to drain commit()'s 800ms persist debounce from whichever test
// ran before them, so a stale pending write could not land on top of the
// legacy record each test saves before init() reads it back. Isolated here,
// that sleep no longer taxes the other tests that used to share the file
// with it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-legacy-restore-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import type { BaptismState } from "../types/stage.js";

const { baptismTimerService } = await import("./baptism-timer-service.js");
const { baptismStore } = await import("./baptism-store.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { sampleArchive } = await import("./archive/sample-archive.js");

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };
const rec = () => serviceTimelineRecorder as unknown as Held;

/** Spies on console.log for lines starting with `prefix`, so a silent no-op
 *  guard can be proven to say why it did nothing rather than just that it
 *  didn't throw. Restore with release() even on assertion failure. */
function captureLog(prefix: string): { lines: string[]; release: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith(prefix)) lines.push(args[0]);
  };
  return {
    lines,
    release: () => {
      console.log = original;
    },
  };
}

describe("undo() survives a restored record that has no people to step back into", () => {
  it("does not throw when a pre-mode record restores as grouped/baptism with an empty people list", async () => {
    // Drives the real store and the real init(), not a hand-built state object:
    // the only way to reach this branch is a PERSISTED record, and constructing
    // the state by hand would prove nothing about whether init() can produce it.
    //
    // The record below is what a session saved before `mode` existed looks like
    // — per-person, person 1 mid-baptism, so `people` is still empty and their
    // testimony lives in pendingTestimonyMs. init() spreads it over
    // idleState(fallback), and the fallback is "grouped" (the default), so it
    // comes back as grouped/baptism/baptismIndex 0 with people: []. undo()'s
    // `baptismIndex === 0` branch popped that empty array and read
    // `.testimonyMs` off undefined — a TypeError out of undo(), a 500 from
    // POST /api/baptism/undo, and no Undo for the rest of the service.
    //
    // No debounce-drain wait here: this is the first test in this file's own
    // module graph, so nothing scheduled a persist before it ran.
    const legacy = {
      phase: "baptism",
      personNumber: 1,
      segmentStartedAt: new Date().toISOString(),
      sessionStartedAt: new Date().toISOString(),
      finishedAt: null,
      people: [],
      pendingTestimonyMs: 12345,
      serviceTitle: null,
      serviceTypeId: null,
      planId: null,
    } as unknown as BaptismState;
    await baptismStore.saveCurrent(legacy);
    await baptismTimerService.init();

    const restored = baptismTimerService.getState();
    assert.equal(restored.mode, "grouped", "sanity: a record with no mode restores on the grouped default");
    assert.equal(restored.phase, "baptism");
    assert.equal(restored.baptismIndex, 0, "sanity: a record with no baptismIndex restores at 0");
    assert.equal(restored.people.length, 0, "sanity: the branch's own precondition — nothing to pop");

    const cap = captureLog("[baptism] undo:");
    let after: BaptismState;
    try {
      after = baptismTimerService.undo();
    } finally {
      cap.release();
    }
    assert.equal(after.phase, "baptism", "with nobody to step back to, undo() is a no-op, not a crash");
    assert.equal(after.people.length, 0);
    assert.deepEqual(
      cap.lines,
      ["[baptism] undo: ignored, the restored session has nobody at baptismIndex 0"],
      "a silent no-op is how an operator's Undo press looked like it did nothing, because it did — this line is the only trace",
    );

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });
});

describe("next(), advance() and finish() survive the same restored record undo() had to survive", () => {
  // Same restored shape as the block above — a pre-mode record saved mid-baptism
  // restores (init()'s grouped fallback) as grouped/baptism/baptismIndex 0 with
  // an empty people list. undo()'s baptismIndex===0 branch was fixed for this
  // shape already; next() and finish() dereferenced `people[this.state.
  // baptismIndex]` the same way and were not. advance() is the panel's primary
  // button and the single entry point Companion keys and custom-layout buttons
  // route through, and it dispatches straight into next() here (armed is
  // false, phase is not idle/testimony), so both /api/baptism/next and
  // /api/baptism/advance 500'd on this exact restore.
  const legacy = {
    phase: "baptism",
    personNumber: 1,
    segmentStartedAt: new Date().toISOString(),
    sessionStartedAt: new Date().toISOString(),
    finishedAt: null,
    people: [],
    pendingTestimonyMs: 12345,
    serviceTitle: null,
    serviceTypeId: null,
    planId: null,
  } as unknown as BaptismState;

  /** Drains the previous test's 800ms persist debounce before this test's own
   *  saveCurrent() runs, so a pending write from the test before cannot land on
   *  top of the record this test saves before init() reads it back — same
   *  reasoning as the sibling undo() guard above. Still needed here even in
   *  this file's own module graph: each test in this describe drives
   *  undo()/next()/advance()/finish(), which schedules its own commit()
   *  persist that the NEXT test's saveCurrent() must outlast. */
  async function restoreLegacy(): Promise<void> {
    await new Promise((r) => setTimeout(r, 900));
    await baptismStore.saveCurrent(legacy);
    await baptismTimerService.init();
  }

  it("next() does not throw and leaves the session untouched with nobody at this index", async () => {
    await restoreLegacy();
    const restored = baptismTimerService.getState();
    assert.equal(restored.phase, "baptism");
    assert.equal(restored.baptismIndex, 0);
    assert.equal(restored.people.length, 0, "sanity: the branch's own precondition — nobody to baptize");

    const cap = captureLog("[baptism] next:");
    let after: BaptismState;
    try {
      after = baptismTimerService.next();
    } finally {
      cap.release();
    }
    assert.equal(after.phase, "baptism", "with nobody at this index, next() is a no-op, not a crash");
    assert.equal(after.people.length, 0);
    assert.deepEqual(
      cap.lines,
      ["[baptism] next: ignored, the restored session has nobody at baptismIndex 0"],
      "the panel's primary button must say why it did nothing, not just do nothing silently",
    );

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("advance() does not throw for the same restored record — it is the panel's primary button", async () => {
    await restoreLegacy();
    const restored = baptismTimerService.getState();
    assert.equal(restored.armed ?? false, false, "sanity: advance() dispatches straight into next() from here");

    const cap = captureLog("[baptism] next:");
    let after: BaptismState;
    try {
      after = baptismTimerService.advance();
    } finally {
      cap.release();
    }
    assert.equal(after.phase, "baptism", "with nobody at this index, advance() is a no-op, not a crash");
    assert.equal(after.people.length, 0);
    assert.deepEqual(
      cap.lines,
      ["[baptism] next: ignored, the restored session has nobody at baptismIndex 0"],
      "advance() dispatches into next() here, so the same trace must appear for the panel's primary button",
    );

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("finish() does not archive a person-complete row carrying a literal 't=undefined' detail", async () => {
    await restoreLegacy();
    rec().current = { serviceKey: "st1:plan1:finish-guard", serviceDate: "2026-09-20", endedAt: null };

    const recorded: { event: string; detail: string }[] = [];
    const original = sampleArchive.recordBaptism;
    (sampleArchive as unknown as { recordBaptism: (...args: unknown[]) => void }).recordBaptism = (
      ...args: unknown[]
    ) => {
      const fields = args[1] as { event: string; detail: string };
      recorded.push({ event: fields.event, detail: fields.detail });
    };

    const cap = captureLog("[baptism] finish:");
    try {
      const after = baptismTimerService.finish();
      assert.equal(after.phase, "idle", "finish() must still close the session with nobody at this index");

      const personComplete = recorded.filter((r) => r.event === "person-complete");
      assert.equal(
        personComplete.length,
        0,
        "nobody was actually baptized here, so a person-complete row would be dishonest",
      );
      assert.ok(
        !recorded.some((r) => r.detail.includes("undefined")),
        `no archived row may carry the literal string "undefined" in its detail: ${JSON.stringify(recorded)}`,
      );
      // finalize() below still archives a "finish" row unconditionally, so this
      // path isn't fully silent the way next()'s is — but that row alone can't
      // tell a genuinely empty service apart from a corrupted restore, so this
      // line is the thing that names the second case.
      assert.deepEqual(
        cap.lines,
        ["[baptism] finish: closing with nobody at baptismIndex 0 — no person-complete row recorded"],
      );
    } finally {
      cap.release();
      (sampleArchive as unknown as { recordBaptism: typeof sampleArchive.recordBaptism }).recordBaptism = original;
      rec().current = null;
    }

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });
});
