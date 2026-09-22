import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-armed-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("./baptism-timer-service.js");
const { baptismStore } = await import("./baptism-store.js");

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
