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
});
