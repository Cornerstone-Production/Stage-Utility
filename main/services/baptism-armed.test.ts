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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
 *  can never legitimately coexist.
 *
 *  One-directional on purpose, and named to say so: idle and paused states
 *  also have segmentStartedAt === null without being armed, so "not armed"
 *  alone implies nothing about the clock. Call this only where armed may be
 *  true; a call site that already knows armed is false proves nothing by
 *  calling it and should assert the specific invariant that holds there
 *  instead (see the I3 and M8 tests below). */
function assertArmedImpliesNoClock(state: { armed?: boolean; segmentStartedAt: string | null }, where: string): void {
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
    assertArmedImpliesNoClock(after, "after resume() while armed");

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
    // No assertArmedImpliesNoClock call here: armed is already known false, so
    // it would check nothing beyond the two assertions immediately above.

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
    // The invariant that actually holds once armed is known false here: this
    // undo branch resumes through startSegment(0), so a clock must now be
    // running. assertArmedImpliesNoClock would check nothing (armed is false),
    // so assert that directly instead.
    assert.notEqual(restored.segmentStartedAt, null, "undo out of a finished baptism must resume a running clock");

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
