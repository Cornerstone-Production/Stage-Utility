import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-armed-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import type { BaptismState } from "../types/stage.js";

const { baptismTimerService } = await import("./baptism-timer-service.js");
const { baptismStore } = await import("./baptism-store.js");
const { segmentElapsedMs } = await import("./baptism-elapsed.js");
const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");
const { sampleArchive } = await import("./archive/sample-archive.js");

type Held = { current: { serviceKey: string; serviceDate: string; endedAt: string | null } | null };
const rec = () => serviceTimelineRecorder as unknown as Held;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("default workflow", () => {
  it("starts grouped, because that is how a baptism is run here", async () => {
    await baptismTimerService.init();
    assert.equal(baptismTimerService.getState().mode, "grouped");
  });

  it("resumes per-person when a session persisted in that mode, even though the default is grouped", async () => {
    const resumedSession: BaptismState = {
      mode: "per-person",
      phase: "idle",
      personNumber: 0,
      baptismIndex: 0,
      segmentStartedAt: null,
      sessionStartedAt: null,
      finishedAt: null,
      people: [],
      pendingTestimonyMs: null,
      serviceTitle: null,
      serviceTypeId: null,
      planId: null,
    };
    await baptismStore.saveCurrent(resumedSession);
    try {
      await baptismTimerService.init();
      assert.equal(baptismTimerService.getState().mode, "per-person");
    } finally {
      // Runs even if the assertion above throws, so a failure here does not
      // leave the persisted per-person session to poison a later test.
      await baptismStore.saveCurrent(null);
    }
  });
});

describe("grouped baptisms begin armed", () => {
  it("runs no clock until the first person steps in", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();          // testimony, person 1
    baptismTimerService.next();           // bank person 1's testimony
    const armedAt = baptismTimerService.startBaptisms();

    assert.equal(armedAt.phase, "baptism");
    assert.equal(armedAt.armed, true, "the song going live must not start person 1's clock");
    assert.equal(armedAt.segmentStartedAt, null, "no clock may be running while armed");
    assert.equal(armedAt.segmentAccumMs ?? 0, 0);

    const running = baptismTimerService.advance();  // "First person in"
    assert.equal(running.armed ?? false, false, "the first press clears armed");
    assert.notEqual(running.segmentStartedAt, null, "and starts person 1");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("does not bank the armed stretch onto person 1", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    baptismTimerService.next();
    baptismTimerService.startBaptisms();
    // Whatever elapses while armed belongs to nobody.
    const before = Date.now();
    baptismTimerService.advance();
    const startedMs = Date.parse(baptismTimerService.getState().segmentStartedAt as string);
    assert.ok(startedMs >= before, "person 1's clock starts at the press, not at the arming");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("undo out of an armed baptism phase does not leave armed stuck", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    baptismTimerService.next();
    const armedAt = baptismTimerService.startBaptisms();
    assert.equal(armedAt.armed, true);

    // Mis-tap: undo back to testimonies before anyone was baptized. A clock is
    // running again (this IS the testimony section, resumed), so the state can no
    // longer read as armed — a stale flag here would make the panel's primary
    // button offer "Baptize person 1" while showing a testimony readout.
    const back = baptismTimerService.undo();
    assert.equal(back.phase, "testimony");
    assert.equal(back.armed ?? false, false, "undo must not leave a stale armed flag on the testimony phase");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });
});

// "First person in" is the press made most often during the songs, so tapping
// it a beat early and pressing Undo is the likeliest mis-tap in the grouped
// workflow. undo() at baptismIndex 0 returned to the testimonies whether or not
// that press had happened: it took back the first press AND the arming, left
// the last testifier's testimony clock running, and that testimony absorbed
// everything until "Start baptisms" was pressed again.
describe("undo around the first person in takes back one press, not two", () => {
  it("after First person in, undo re-arms: no clock, nothing banked, the folded person still waiting", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start(); // person 1's testimony
    await sleep(30);
    baptismTimerService.next(); // person 1's testimony banked, person 2's begins
    await sleep(40);
    const armedAt = baptismTimerService.startBaptisms(); // person 2's testimony folds in, the section arms
    assert.equal(armedAt.people.length, 2, "sanity: both testimonies are in");

    baptismTimerService.advance(); // "First person in", a beat early: nobody is in the water
    await sleep(150);
    const undone = baptismTimerService.undo();

    // Nothing but that press changed the state since the arming, so taking back
    // exactly that press lands on exactly the state "Start baptisms" armed into:
    // phase baptism, armed, no clock, nothing banked, and the same people —
    // person 2, folded in by the arming, still waiting to be baptized, carrying
    // the testimony time the arming banked for them and not a millisecond more.
    assert.deepEqual(undone, armedAt, "undo after First person in must take back that press alone");

    await sleep(150); // the real walk-up, which belongs to nobody while armed
    const running = baptismTimerService.advance(); // "First person in", for real
    assert.equal(running.armed ?? false, false, "sanity: the re-armed section takes the first press again");
    assert.notEqual(running.segmentStartedAt, null, "sanity: and starts person 1's clock");
    await sleep(40); // person 1's baptism
    baptismTimerService.advance(); // "Next person in"
    await sleep(30); // person 2's baptism
    const finished = baptismTimerService.finish(); // "Last person out"

    assert.deepEqual(
      finished.people.map((p) => p.testimonyMs),
      armedAt.people.map((p) => p.testimonyMs),
      "every testimony is exactly what the arming banked — none absorbed the undone press or the walk-up",
    );
    const [first, second] = finished.people;
    // Person 1 carries only the baptism after the second press (~40ms). Had the
    // undo kept their clock, the undone press's 150ms would be on them; had it
    // restarted their clock instead of re-arming, the 150ms walk-up would be.
    assert.ok(
      first!.baptizeMs >= 30 && first!.baptizeMs < 100,
      `person 1's baptism runs from the second First person in (got ${first!.baptizeMs}ms)`,
    );
    assert.ok(second!.baptizeMs > 0, "person 2 was baptized");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("undo after First person in banks nothing, even with person 1's clock paused", async () => {
    // The test above cannot see a re-arm that forgets to clear the bank:
    // advance() had already zeroed it. A pause is what puts time there, and left
    // behind it would sit on the armed readout, which must hold at 0:00.
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    await sleep(20);
    const armedAt = baptismTimerService.startBaptisms();
    baptismTimerService.advance(); // "First person in"
    await sleep(30);
    const paused = baptismTimerService.pause();
    assert.ok((paused.segmentAccumMs ?? 0) > 0, "sanity: the pause banked person 1's time");

    assert.deepEqual(baptismTimerService.undo(), armedAt, "re-armed with nothing banked, exactly as the arming left it");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("while still armed, undo returns to the testimonies and resumes the last one from its banked time", async () => {
    // "Start baptisms" pressed too early, or armed by the wrong song. Pinned
    // beside the case above because both are the same undo() branch split on
    // `armed`: this half must keep doing exactly this.
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    baptismTimerService.next();
    await sleep(40); // a testimony long enough that resuming from zero cannot match it
    const armedAt = baptismTimerService.startBaptisms();
    const folded = armedAt.people[armedAt.people.length - 1]!;
    assert.ok(folded.testimonyMs > 0, "sanity: the folded testimony banked real time");

    const undone = baptismTimerService.undo();
    assert.deepEqual(
      {
        phase: undone.phase,
        armed: undone.armed ?? false,
        people: undone.people,
        personNumber: undone.personNumber,
        segmentAccumMs: undone.segmentAccumMs,
      },
      {
        phase: "testimony",
        armed: false,
        // The folded testimony leaves `people`, or a re-arm folds it a second time...
        people: armedAt.people.slice(0, -1),
        // ...and is the one speaking again,
        personNumber: armedAt.people.length,
        // resumed from what the arming banked, not from zero.
        segmentAccumMs: folded.testimonyMs,
      },
    );
    assert.notEqual(undone.segmentStartedAt, null, "the resumed testimony's clock is running");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });
});

/** armed === true implies segmentStartedAt === null, always. An armed segment
 *  has no clock running by definition — see BaptismState.armed — so the two
 *  can never legitimately coexist. */
function assertNotArmedAndRunning(state: { armed?: boolean; segmentStartedAt: string | null }, where: string): void {
  if (state.armed) {
    assert.equal(state.segmentStartedAt, null, `${where}: armed is true but a clock is running`);
  }
}

describe("armed is contained — it cannot survive the action that ends it", () => {
  it("C1: resume() must not stamp a start time while armed", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    baptismTimerService.next();
    const armedAt = baptismTimerService.startBaptisms();
    assert.equal(armedAt.armed, true);

    // The documented route an operator's panel would call if a paused testimony
    // auto-armed on the song while the already-rendered button still said
    // "Resume" — the exact race the reviewer named.
    const after = baptismTimerService.resume();
    assert.equal(after.armed, true, "resume() must leave armed alone, not silently clear it");
    assertNotArmedAndRunning(after, "after resume() while armed");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("C2: finish() must not persist armed on a finished session", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    baptismTimerService.next();
    baptismTimerService.startBaptisms();

    const finished = baptismTimerService.finish();
    assert.equal(finished.phase, "idle");
    assert.equal(
      finished.armed ?? false,
      false,
      "a finished session must not read armed — the panel checks armed before phase === \"idle\"",
    );

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("I3: next() called directly while armed must not leave armed stuck under a running clock", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    baptismTimerService.next(); // bank person 1's testimony, person 2's begins
    const armedAt = baptismTimerService.startBaptisms(); // finalizes person 2 — arms over 2 people
    assert.equal(armedAt.armed, true);
    assert.equal(armedAt.people.length, 2);

    // /api/baptism/next is a documented, reachable route — this is not a
    // hypothetical misuse.
    const after = baptismTimerService.next();
    assert.equal(after.baptismIndex, 1, "moved to the next person");
    assert.notEqual(after.segmentStartedAt, null, "a clock is now running");
    assert.equal(after.armed ?? false, false, "armed must not survive next() while it was true");
    assertNotArmedAndRunning(after, "after next() while armed");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });

  it("M8: undo() restores into the baptism phase from a finished grouped session", async () => {
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    baptismTimerService.startBaptisms();
    baptismTimerService.advance(); // first press — starts person 1's clock
    const finished = baptismTimerService.finish();
    assert.equal(finished.phase, "idle");
    assert.ok(finished.finishedAt);

    const restored = baptismTimerService.undo();
    assert.equal(restored.phase, "baptism");
    assert.equal(restored.finishedAt, null);
    assert.equal(restored.armed ?? false, false, "restoring into a redo must not read as armed");
    assertNotArmedAndRunning(restored, "after undo() out of a finished session");

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });
});

describe("I-B: resume() must count on from what pause() banked", () => {
  it("does not default the banked accumulator to zero", async () => {
    // Before startSegment() existed, resume() wrote `segmentAccumMs: 0` only if
    // someone typed it — nothing to accidentally omit. The refactor briefly
    // made zero the DEFAULT (`accumMs = 0`), so dropping resume()'s one
    // argument (`this.state.segmentAccumMs ?? 0`) silently discarded the banked
    // time instead of failing loudly. `accumMs` is now required, so that exact
    // omission is a type error — this test still guards the behaviour the type
    // checker cannot state: that the value passed is the BANKED one rather than
    // a hard-coded 0. The defect it names is the one the comment above resume()
    // describes: a testimony paused through the prayer came back reading the
    // length of the prayer.
    baptismTimerService.reset();
    baptismTimerService.setMode("grouped");
    baptismTimerService.start();
    await new Promise((r) => setTimeout(r, 20)); // let some real time bank

    const paused = baptismTimerService.pause();
    const banked = paused.segmentAccumMs ?? 0;
    assert.ok(banked > 0, "expected pause() to have banked some elapsed time");

    const resumed = baptismTimerService.resume();
    assert.equal(resumed.segmentAccumMs, banked, "resume() must keep what pause() banked, not reset it to zero");
    assert.notEqual(resumed.segmentStartedAt, null, "resume() must start a clock");

    // Read right after resuming: if the accumulator had been zeroed, this would
    // read close to 0ms instead of at least the banked amount.
    const elapsedRightAfter = segmentElapsedMs(resumed);
    assert.ok(
      elapsedRightAfter >= banked,
      `expected elapsed (${elapsedRightAfter}ms) to count on from banked (${banked}ms), not restart from zero`,
    );

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });
});

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
    // The 900ms wait drains commit()'s 800ms persist debounce from the tests
    // above, so their pending write cannot land on top of the record this test
    // saves before init() reads it.
    await new Promise((r) => setTimeout(r, 900));
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
   *  reasoning as the sibling undo() guard above. */
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
