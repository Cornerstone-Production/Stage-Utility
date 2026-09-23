// The PCO Live action's tests. The guarantee worth protecting here is that one
// invocation issues at most ONE step: PCO has no jump action, so a rule that
// looped would fire every item it stepped over, live, in front of the room.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// baptism.* mutates the real baptismTimerService singleton, which debounces a
// persist through baptismStore 800ms after every commit(). Unset, that write
// lands in the real ~/.stage-utility — the default data dir a dev/prod
// instance on this machine actually uses. Set before anything below can reach
// getUserDataPath()'s lazy, memoized resolution (see app-paths.ts).
process.env.STAGE_UTILITY_DATA ??= await fs.mkdtemp(path.join(os.tmpdir(), "stage-automation-actions-"));

import type { BaptismState, PcoLiveDTO } from "../types/stage.js";
import { AUTOMATION_ACTIONS, liveDeps } from "./automation-actions.js";
import { advanceGuard } from "./automation-pco-items.js";
import { reaperDeps } from "./reaper-service.js";
import { baptismTimerService } from "./baptism-timer-service.js";
import { baptismStore } from "./baptism-store.js";

describe("advanceGuard", () => {
  it("allows the step when the next item matches", () => {
    assert.equal(advanceGuard("Doors Open", "doors").advance, true);
  });

  it("blocks the step when the next item is something else", () => {
    const v = advanceGuard("Welcome", "doors");
    assert.equal(v.advance, false);
    // The reason has to name both, or the log cannot explain the skip.
    assert.match(v.reason, /Welcome/);
    assert.match(v.reason, /doors/);
  });

  it("steps unconditionally when no guard is given", () => {
    assert.equal(advanceGuard("Anything", "").advance, true);
    assert.equal(advanceGuard(null, "   ").advance, true);
  });

  it("blocks when PCO reports no next item", () => {
    const v = advanceGuard(null, "doors");
    assert.equal(v.advance, false);
    assert.match(v.reason, /no next item/);
  });
});

describe("pco.live.advance", () => {
  const action = AUTOMATION_ACTIONS["pco.live.advance"];
  const realGetLive = liveDeps.getLive;
  const realAdvance = liveDeps.advance;
  afterEach(() => {
    liveDeps.getLive = realGetLive;
    liveDeps.advance = realAdvance;
  });

  let calls = 0;
  function fakePco(nextItemTitle: string | null, onAdvance?: () => Promise<void>): void {
    calls = 0;
    liveDeps.getLive = () => ({ nextItemTitle } as PcoLiveDTO);
    liveDeps.advance = async () => {
      calls++;
      if (onAdvance) await onAdvance();
    };
  }

  it("advances when the next item matches the guard", async () => {
    fakePco("Doors Open");
    const r = await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(r.ok, true);
    assert.equal(calls, 1);
    assert.match(r.detail, /^advanced/);
  });

  it("does NOT advance when the next item does not match", async () => {
    fakePco("Welcome");
    const r = await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(calls, 0, "it stepped the live plan despite the guard");
    assert.match(r.detail, /^skipped/);
    assert.match(r.detail, /Welcome/);
  });

  it("advances unguarded when no guardTitle is given", async () => {
    fakePco("Whatever");
    await action.run({}, { simulate: false });
    assert.equal(calls, 1);
  });

  it("issues no request at all in simulate mode", async () => {
    fakePco("Doors Open");
    const r = await action.run({ guardTitle: "doors" }, { simulate: true });
    assert.equal(calls, 0);
    assert.match(r.detail, /^would advance/);
  });

  it("reports PCO's own wording when it refuses", async () => {
    // A silent rule is this feature's worst failure, so the 403 body has to
    // survive intact all the way to the Activity log.
    fakePco("Doors Open", async () => {
      throw new Error("PCO API error 403: You are not a live controller for this plan");
    });
    const r = await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /403/);
    assert.match(r.detail, /not a live controller/);
  });

  it("never steps more than once per invocation", async () => {
    // The no-loop guarantee, asserted rather than assumed.
    fakePco("Doors Open");
    await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(calls, 1);
  });

  it("never throws, whatever PCO does", async () => {
    // The engine trusts every action to return rather than throw; one bad
    // provider must not stop the rules that follow it.
    liveDeps.getLive = () => {
      throw new Error("no plan selected");
    };
    const r = await action.run({ guardTitle: "doors" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /no plan selected/);
  });
});

describe("reaper.transport", () => {
  const action = AUTOMATION_ACTIONS["reaper.transport"];
  const realFetch = reaperDeps.fetch;
  afterEach(() => {
    reaperDeps.fetch = realFetch;
  });

  it("simulate contacts REAPER not at all", async () => {
    // The stub counts a contact and refuses it: a simulated cue that reads the
    // transport is a cue that cannot be tested with REAPER off the network,
    // which is where a rule is usually written.
    let called = 0;
    reaperDeps.fetch = (async () => {
      called++;
      throw new Error("simulate reached REAPER");
    }) as typeof fetch;
    const r = await action.run({ command: "record" }, { simulate: true });
    assert.deepEqual(r, { ok: true, detail: "would send record" });
    assert.equal(called, 0);
  });

  it("refuses a command it does not have", async () => {
    const r = await action.run({ command: "rewind" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /not a REAPER transport command/);
  });

  it("reports an unconfigured REAPER rather than throwing", async () => {
    const r = await action.run({ command: "stop" }, { simulate: false });
    assert.equal(r.ok, false);
    assert.match(r.detail, /not configured/);
  });
});

describe("baptism actions", () => {
  afterEach(() => {
    baptismTimerService.reset();
  });

  // EXACT, sorted, one entry per line — never a bare count. See
  // routes/baptism-actions.test.ts for why: a count cannot tell an id added in
  // one branch and removed in another from no change at all.
  it("registers exactly this sorted list of ids", () => {
    const ids = Object.keys(AUTOMATION_ACTIONS).filter((id) => id.startsWith("baptism."));
    assert.deepEqual(ids.sort(), [
      "baptism.advance",
      "baptism.back",
      "baptism.finish",
      "baptism.pause",
      "baptism.start",
    ]);
  });

  describe("baptism.start", () => {
    it("begins person 1's testimony from idle", async () => {
      baptismTimerService.reset();
      const r = await AUTOMATION_ACTIONS["baptism.start"]!.run({}, { simulate: false });
      assert.equal(r.ok, true);
      assert.equal(baptismTimerService.getState().phase, "testimony");
      assert.equal(baptismTimerService.getState().personNumber, 1);
    });

    it("refuses when a session is already running", async () => {
      baptismTimerService.reset();
      baptismTimerService.start();
      const r = await AUTOMATION_ACTIONS["baptism.start"]!.run({}, { simulate: false });
      assert.equal(r.ok, false);
      assert.match(r.detail, /already running/);
    });

    it("issues no state change in simulate mode", async () => {
      baptismTimerService.reset();
      const before = baptismTimerService.getState();
      const r = await AUTOMATION_ACTIONS["baptism.start"]!.run({}, { simulate: true });
      assert.equal(r.ok, true);
      assert.equal(baptismTimerService.getState(), before, "simulate must not call the real service");
    });
  });

  describe("baptism.advance", () => {
    it("from idle, starts a session", async () => {
      baptismTimerService.reset();
      const r = await AUTOMATION_ACTIONS["baptism.advance"]!.run({}, { simulate: false });
      assert.equal(r.ok, true);
      assert.match(r.detail, /started/);
      assert.equal(baptismTimerService.getState().phase, "testimony");
      assert.equal(baptismTimerService.getState().personNumber, 1);
    });

    it("from armed, begins person 1 without banking the wait", async () => {
      baptismTimerService.reset();
      baptismTimerService.setMode("grouped");
      baptismTimerService.start();
      baptismTimerService.next(); // bank person 1's testimony
      baptismTimerService.startBaptisms(); // arms — no clock runs yet
      assert.equal(baptismTimerService.getState().armed, true);

      const r = await AUTOMATION_ACTIONS["baptism.advance"]!.run({}, { simulate: false });
      assert.equal(r.ok, true);
      assert.equal(baptismTimerService.getState().armed, false);
      assert.ok(baptismTimerService.getState().segmentStartedAt, "person 1's clock must now be running");
    });

    it("from a per-person testimony, marks baptized", async () => {
      baptismTimerService.reset();
      baptismTimerService.setMode("per-person");
      baptismTimerService.start();
      const r = await AUTOMATION_ACTIONS["baptism.advance"]!.run({}, { simulate: false });
      assert.equal(r.ok, true);
      assert.equal(baptismTimerService.getState().phase, "baptism");
    });

    it("never contacts the service in simulate mode", async () => {
      baptismTimerService.reset();
      const before = baptismTimerService.getState();
      const r = await AUTOMATION_ACTIONS["baptism.advance"]!.run({}, { simulate: true });
      assert.equal(r.ok, true);
      assert.match(r.detail, /would/);
      assert.equal(baptismTimerService.getState(), before, "simulate must not call the real service");
    });

    it("reports failure rather than false success against a restored, corrupted record", async () => {
      // Grouped, phase baptism, baptismIndex 0, armed false, people EMPTY — the
      // exact restored-record shape baptism-timer-service.ts guards in three
      // places. advance() falls through to next(), whose grouped/baptism
      // branch is a documented no-op for this shape (logs "nobody at
      // baptismIndex 0" and returns the SAME state object). Loaded through
      // baptismStore + init(), the way a real restored record arrives, not by
      // reaching into the service's private state.
      const corrupted: BaptismState = {
        mode: "grouped",
        phase: "baptism",
        personNumber: 1,
        baptismIndex: 0,
        armed: false,
        segmentStartedAt: null,
        segmentAccumMs: 0,
        sessionStartedAt: "2026-09-20T12:00:00.000Z",
        finishedAt: null,
        people: [],
        pendingTestimonyMs: null,
        serviceTitle: null,
        serviceTypeId: null,
        planId: null,
      };
      await baptismStore.saveCurrent(corrupted);
      await baptismTimerService.init();
      const before = baptismTimerService.getState();

      const r = await AUTOMATION_ACTIONS["baptism.advance"]!.run({}, { simulate: false });

      assert.equal(r.ok, false, "advance must not report success when the timer did not move");
      assert.match(r.detail, /did not move/);
      assert.equal(baptismTimerService.getState(), before, "the state must be exactly unchanged");
      await baptismStore.saveCurrent(null);
    });
  });

  describe("baptism.back", () => {
    it("undoes the last press", async () => {
      baptismTimerService.reset();
      baptismTimerService.setMode("per-person");
      baptismTimerService.start();
      baptismTimerService.baptized(); // testimony -> baptism
      assert.equal(baptismTimerService.getState().phase, "baptism");

      const r = await AUTOMATION_ACTIONS["baptism.back"]!.run({}, { simulate: false });
      assert.equal(r.ok, true);
      assert.equal(baptismTimerService.getState().phase, "testimony");
    });

    it("says there is nothing to undo from a fresh idle state", async () => {
      baptismTimerService.reset();
      const r = await AUTOMATION_ACTIONS["baptism.back"]!.run({}, { simulate: false });
      assert.equal(r.ok, false);
      assert.match(r.detail, /nothing to undo/);
    });
  });

  describe("baptism.pause", () => {
    it("pauses a running clock", async () => {
      baptismTimerService.reset();
      baptismTimerService.start();
      const r = await AUTOMATION_ACTIONS["baptism.pause"]!.run({}, { simulate: false });
      assert.equal(r.ok, true);
      assert.match(r.detail, /paused/);
      assert.equal(baptismTimerService.getState().segmentStartedAt, null);
    });

    it("resumes a paused clock", async () => {
      baptismTimerService.reset();
      baptismTimerService.start();
      baptismTimerService.pause();
      const r = await AUTOMATION_ACTIONS["baptism.pause"]!.run({}, { simulate: false });
      assert.equal(r.ok, true);
      assert.match(r.detail, /resumed/);
      assert.ok(baptismTimerService.getState().segmentStartedAt, "the clock must be running again");
    });

    it("says there is nothing running to pause when idle", async () => {
      baptismTimerService.reset();
      const r = await AUTOMATION_ACTIONS["baptism.pause"]!.run({}, { simulate: false });
      assert.equal(r.ok, false);
      assert.match(r.detail, /no baptism session/);
    });

    it("says there is nothing running to pause while armed", async () => {
      baptismTimerService.reset();
      baptismTimerService.setMode("grouped");
      baptismTimerService.start();
      baptismTimerService.next();
      baptismTimerService.startBaptisms();
      assert.equal(baptismTimerService.getState().armed, true);

      const r = await AUTOMATION_ACTIONS["baptism.pause"]!.run({}, { simulate: false });
      assert.equal(r.ok, false);
      assert.match(r.detail, /armed/);
    });

    it("issues no state change in simulate mode", async () => {
      baptismTimerService.reset();
      baptismTimerService.start();
      const before = baptismTimerService.getState();
      const r = await AUTOMATION_ACTIONS["baptism.pause"]!.run({}, { simulate: true });
      assert.equal(r.ok, true);
      assert.equal(baptismTimerService.getState(), before, "simulate must not call the real service");
    });
  });

  describe("baptism.finish", () => {
    it("closes the in-progress session", async () => {
      baptismTimerService.reset();
      baptismTimerService.start();
      const r = await AUTOMATION_ACTIONS["baptism.finish"]!.run({}, { simulate: false });
      assert.equal(r.ok, true);
      assert.equal(baptismTimerService.getState().phase, "idle");
    });

    it("refuses when idle, rather than logging a no-op finish", async () => {
      baptismTimerService.reset();
      const r = await AUTOMATION_ACTIONS["baptism.finish"]!.run({}, { simulate: false });
      assert.equal(r.ok, false);
      assert.match(r.detail, /no baptism session/);
    });
  });
});
