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

describe("default workflow", () => {
  it("starts grouped, because that is how a baptism is run here", async () => {
    await baptismTimerService.init();
    assert.equal(baptismTimerService.getState().mode, "grouped");
  });

  it("resumes per-person when a session persisted in that mode, even though the default is grouped", async () => {
    const resumedSession: any = {
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
    await baptismTimerService.init();
    assert.equal(baptismTimerService.getState().mode, "per-person");
    await baptismStore.saveCurrent(null);
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

    const after = baptismTimerService.undo();
    assert.equal(after.phase, "baptism", "with nobody to step back to, undo() is a no-op, not a crash");
    assert.equal(after.people.length, 0);

    baptismTimerService.reset();
    await baptismStore.saveCurrent(null);
  });
});
