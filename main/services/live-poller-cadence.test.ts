// The live poller's delay table, driven through the real poller.
//
// Four rules, each one a past or plausible regression:
//   - a live item polls every 1 s, and never goes dormant whatever the schedule
//     says, because a live item means a service is happening;
//   - with nothing live it polls every 4 s, stretched outside a service window;
//   - past PCO's rate-limit high-water mark, item and idle polls stretch 4x;
//   - a failed read waits the plain idle delay: the 4x is for steady polling,
//     not for a retry, which already backs off through the window.
//
// Only stageController.fetchLive and maybeAutoAdvance, pcoService.rateLimitTight
// and serviceWindow.pollDelayMs are replaced. Every case counts fetches across
// fake time.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, after, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { advance, fakeTime, settle } from "./fixtures/live-poller-clock.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-poller-cadence-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");
const { serviceWindow } = await import("./service-window.js");

after(() => fs.rm(TMP, { recursive: true, force: true }));

const DORMANT_MS = 5 * 60_000;

let fetches = 0;
/** Every read answers `reply` (or throws it, if it is an Error). */
function fetchAnswers(t: TestContext, reply: unknown): void {
  t.mock.method(stageController, "fetchLive", () => {
    fetches++;
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  t.mock.method(stageController, "maybeAutoAdvance", () => Promise.resolve());
}
function rateTight(t: TestContext, tight: boolean): void {
  t.mock.method(pcoService, "rateLimitTight", () => tight);
}
/** Open: the idle delay is what was asked. Dormant: always the dormant ceiling. */
function holdWindow(t: TestContext, state: "open" | "dormant"): void {
  t.mock.method(serviceWindow, "pollDelayMs", (ms: number) => (state === "open" ? ms : DORMANT_MS));
}

const ITEM = { mode: "item", currentItemId: "i1", label: "Welcome", serverNow: "2026-09-20T15:00:00.000Z" };

/** Start, then report how long until the second fetch, to the second. */
async function secondsToSecondFetch(t: TestContext, limitS: number): Promise<number> {
  livePoller.start();
  await settle();
  assert.equal(fetches, 1, "the first tick fetches at once — that is the premise");
  for (let s = 1; s <= limitS; s++) {
    await advance(t, 1_000);
    if (fetches > 1) return s;
  }
  return Infinity;
}

describe("live-poller delay table", () => {
  beforeEach(() => {
    livePoller.stop();
    fetches = 0;
  });
  afterEach(() => livePoller.stop());

  it("a live item polls every second", async (t) => {
    fakeTime(t);
    fetchAnswers(t, ITEM);
    rateTight(t, false);
    holdWindow(t, "open");
    assert.equal(await secondsToSecondFetch(t, 20), 1);
  });

  it("a live item never goes dormant, whatever the schedule says", async (t) => {
    fakeTime(t);
    fetchAnswers(t, ITEM);
    rateTight(t, false);
    holdWindow(t, "dormant");
    assert.equal(await secondsToSecondFetch(t, 20), 1, "a live service polled at the dormant cadence");
  });

  it("a live item stretches 4x while PCO's headroom is tight", async (t) => {
    fakeTime(t);
    fetchAnswers(t, ITEM);
    rateTight(t, true);
    holdWindow(t, "open");
    assert.equal(await secondsToSecondFetch(t, 20), 4);
  });

  it("nothing live polls every 4 s, and 16 s while headroom is tight", async (t) => {
    fakeTime(t);
    fetchAnswers(t, null);
    holdWindow(t, "open");
    rateTight(t, false);
    assert.equal(await secondsToSecondFetch(t, 30), 4);
    livePoller.stop();
    fetches = 0;
    rateTight(t, true);
    assert.equal(await secondsToSecondFetch(t, 30), 16);
  });

  it("a failed read waits the plain idle delay, tight headroom or not", async (t) => {
    fakeTime(t);
    fetchAnswers(t, new Error("fetch failed: ECONNREFUSED"));
    rateTight(t, true);
    holdWindow(t, "open");
    assert.equal(await secondsToSecondFetch(t, 30), 4, "the rate-tight factor was applied to a retry");
  });
});
