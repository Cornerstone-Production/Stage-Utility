// Auto-start used to claim a transition it had not made.
//
// autoStartAction returns "start-baptisms" whenever the bound item goes live and
// the phase is testimony -- in EITHER mode. startBaptisms() returns early unless
// the mode is grouped. onLiveTick ignored the return value and set
// autoStartedFrom regardless, so in per-person mode the song going live painted
// "Started automatically from <song>" on the panel while the timer did nothing.
//
// onLiveTick reads the trigger under stageController.getState().planId — NOT
// under whatever plan a test hands it directly — so the trigger below has to be
// set under that same key or it never matches and the test would go green for
// the wrong reason. getState is stubbed here (the same pattern
// service-recorder.test.ts uses) so the key is pinned rather than left at the
// real default of null, under which baptismTriggersStore.get() short-circuits
// before ever consulting the file.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-auto-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("./baptism-timer-service.js");
const { baptismTriggersStore } = await import("./baptism-triggers-store.js");
const { stageController } = await import("./stage-controller.js");

const PLAN_ID = "plan-auto-1";
(stageController as unknown as { getState(): unknown }).getState = () => ({
  planId: PLAN_ID,
  planTitle: null,
  serviceTypeId: null,
});

describe("auto-start in per-person mode", () => {
  beforeEach(() => {
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");
  });

  it("does not claim it started the baptisms when it could not", async () => {
    await baptismTriggersStore.set(PLAN_ID, { testimonyItemId: null, baptismItemId: "song-1" });
    baptismTimerService.start(); // phase: testimony, per-person

    await baptismTimerService.onLiveTick({
      mode: "item",
      currentItemId: "song-1",
      label: "Great Are You Lord",
    } as never);

    const s = baptismTimerService.getState();
    assert.equal(s.phase, "testimony", "per-person has no grouped baptism section to enter");
    assert.equal(
      s.autoStartedFrom ?? null,
      null,
      "the panel must not say it started from an item when nothing moved",
    );
  });

  // A different item id than the sibling test above ("song-2" not "song-1") --
  // the service is a singleton and its lastAutoItemId/lastWarnedItemId bookkeeping
  // is not reset between tests, so reusing an id would make this test's outcome
  // depend on what a PREVIOUS test already did to that id.
  it("retries an ignored item once the operator fixes the mode, warning only once", async () => {
    await baptismTriggersStore.set(PLAN_ID, { testimonyItemId: null, baptismItemId: "song-2" });
    baptismTimerService.start(); // phase: testimony, per-person

    // Filtered to the auto-start "ignored" warning specifically: the raw
    // archive's own "[baptism] raw: no service open" warning also goes through
    // console.warn (no PCO service is stubbed open in this test), and the
    // reset()+start() retry below legitimately re-fires that one — it is not
    // what this test is about.
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("[baptism] auto-start:")) warnings.push(args);
    };
    try {
      const tick = () =>
        baptismTimerService.onLiveTick({
          mode: "item",
          currentItemId: "song-2",
          label: "Great Are You Lord",
        } as never);

      // PCO holds on this item for a while — two ticks before the operator acts.
      await tick();
      await tick();

      assert.equal(
        baptismTimerService.getState().phase,
        "testimony",
        "still wrong mode for a grouped-only trigger — nothing should have moved",
      );
      assert.equal(warnings.length, 1, "the second tick on the SAME ignored item must not warn again");

      // The operator reads the warning and fixes the workflow, but PCO is still
      // sitting on the exact same item — nothing else changed.
      baptismTimerService.reset();
      baptismTimerService.setMode("grouped");
      baptismTimerService.start(); // phase: testimony, grouped

      await tick();

      const s = baptismTimerService.getState();
      assert.equal(s.phase, "baptism", "the same item must be re-evaluated once the mode is fixed");
      assert.equal(
        s.autoStartedFrom,
        "Great Are You Lord",
        "the retry that actually moved the phase should say so",
      );
      assert.equal(warnings.length, 1, "a retry that succeeds must not add another warning");
    } finally {
      console.warn = originalWarn;
    }
  });
});
