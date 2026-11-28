// Whether the service times are known well enough to restart a Mac helper's
// outputs on (machine-updates.ts). Not knowing must never read as "nothing is
// on": right after the server starts, while Planning Center fails, and when only
// some of a schedule could be read.
//
// Planning Center is stubbed: it is the network. What is pinned is what
// refreshServiceWindows and serviceTimesKnown make of what it answers.

import assert from "node:assert/strict";
import { describe, it, beforeEach, after, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-service-times-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
// Wires the controller's auto-update to the update lock's check, as server.ts does.
await import("./service-activity.js");
const { pcoService } = await import("./pco-service.js");
const { serviceWindow } = await import("./service-window.js");
const { captureConsole } = await import("./fixtures/capture-console.js");
const { setAppTimeZone, zonedParts } = await import("./app-timezone.js");
const { updater } = await import("./updater.js");

type Mutable = {
  state: Record<string, unknown>;
  pcoAppId: string | null;
  pcoSecret: string | null;
  lastLive: unknown;
  liveStale: boolean;
};
const ctl = stageController as unknown as Mutable;
const pco = pcoService as unknown as Record<string, unknown>;
const real = {
  listServiceTypes: pco.listServiceTypes,
  listUpcomingPlans: pco.listUpcomingPlans,
  listPlanTimes: pco.listPlanTimes,
  getLive: pco.getLive,
};

const soon = Date.now() + 3_600_000;
function answering(opts: { plans?: "fail"; times?: "fail" } = {}) {
  pco.listServiceTypes = async () => [{ id: "1", name: "Sunday" }];
  pco.listUpcomingPlans = async () => {
    if (opts.plans === "fail") throw new Error("429");
    return [{ id: "p1" }];
  };
  pco.listPlanTimes = async () => {
    if (opts.times === "fail") throw new Error("timeout");
    return [{ startsAt: new Date(soon).toISOString(), endsAt: new Date(soon + 3_600_000).toISOString(), timeType: "service" }];
  };
}

describe("serviceTimesKnown", () => {
  beforeEach(() => {
    ctl.pcoAppId = "app";
    ctl.pcoSecret = "secret";
    ctl.state = { ...ctl.state, serviceTypeId: null, planId: null };
    ctl.lastLive = null;
    ctl.liveStale = false;
    serviceWindow.markUnknown();
  });
  after(async () => {
    Object.assign(pco, real);
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("is known without Planning Center at all", () => {
    ctl.pcoAppId = null;
    ctl.pcoSecret = null;
    assert.equal(stageController.serviceTimesKnown(), true);
  });

  it("is not known before the windows have been read", () => {
    assert.equal(stageController.serviceTimesKnown(), false);
  });

  it("is known once every plan's times were read", async () => {
    answering();
    await stageController.refreshServiceWindows();
    assert.equal(stageController.serviceTimesKnown(), true);
  });

  it("is not known when a plan list could not be read, though the rest was", async () => {
    answering({ plans: "fail" });
    await stageController.refreshServiceWindows();
    assert.equal(stageController.serviceTimesKnown(), false);
  });

  it("is not known when a plan's times could not be read", async () => {
    answering({ times: "fail" });
    await stageController.refreshServiceWindows();
    assert.equal(stageController.serviceTimesKnown(), false);
  });

  it("waits for the followed plan's live state too", async () => {
    answering();
    await stageController.refreshServiceWindows();
    ctl.state = { ...ctl.state, serviceTypeId: "1", planId: "p1" };
    assert.equal(stageController.serviceTimesKnown(), false);
    ctl.lastLive = { mode: "none" };
    assert.equal(stageController.serviceTimesKnown(), true);
  });

  it("is not known while the live state cannot be read, though an older reading said nothing was live", async (t) => {
    // A 429 or a dropped network leaves the last reading in place. It said no
    // service was live; one may have started since.
    const lines = captureConsole(t as TestContext, "warn", "log");
    answering();
    await stageController.refreshServiceWindows();
    ctl.state = { ...ctl.state, serviceTypeId: "1", planId: "p1" };
    let answer: "none" | "fail" = "none";
    pco.getLive = async () => {
      if (answer === "fail") throw new Error("429 Too Many Requests");
      return { mode: "none" };
    };

    await stageController.fetchLive();
    assert.equal(stageController.serviceTimesKnown(), true);

    answer = "fail";
    await assert.rejects(() => stageController.fetchLive(), /429/);
    await assert.rejects(() => stageController.fetchLive(), /429/);
    assert.equal(stageController.serviceTimesKnown(), false, "a failed live read left a stale reading counting as known");
    assert.equal(lines.filter((l) => l.startsWith("[pco] live state unknown")).length, 1, lines.join("\n"));

    answer = "none";
    await stageController.fetchLive();
    assert.equal(stageController.serviceTimesKnown(), true);
    assert.ok(lines.includes("[pco] live state known again"), lines.join("\n"));
  });
});

// The server's own updater (shouldAutoApply) waits out the cached service windows
// whether or not Planning Center answers, and does not wait for Planning Center
// itself: a long outage must not hold every update.
describe("shouldAutoApply and the cached service windows", () => {
  const now = new Date();
  beforeEach(() => {
    ctl.pcoAppId = "app";
    ctl.pcoSecret = "secret";
    ctl.state = {
      ...ctl.state,
      serviceTypeId: "1",
      planId: "p1",
      autoUpdate: { mode: "auto-full", dayOfWeek: null, hour: zonedParts(now.getTime()).hour },
    };
    ctl.lastLive = { mode: "none" };
    ctl.liveStale = false;
  });
  after(() => {
    Object.assign(pco, real);
    serviceWindow.setWindows([]);
  });

  async function liveReadFails(t: TestContext): Promise<void> {
    captureConsole(t, "warn", "log");
    pco.getLive = async () => { throw new Error("429 Too Many Requests"); };
    await assert.rejects(() => stageController.fetchLive(), /429/);
  }

  it("waits inside a cached service window, whether the live state is known or not", async (t) => {
    serviceWindow.setWindows([{ open: now.getTime() - 60_000, close: now.getTime() + 3_600_000 }]);
    assert.deepEqual(stageController.shouldAutoApply(1, now), { apply: false, why: "window" }, "a current reading of nothing live let it restart inside the window");
    await liveReadFails(t);
    assert.deepEqual(stageController.shouldAutoApply(1, now), { apply: false, why: "window" });
  });

  it("says once, on a tagged line, that it is waiting", async (t) => {
    serviceWindow.setWindows([{ open: now.getTime() - 60_000, close: now.getTime() + 3_600_000 }]);
    await liveReadFails(t);
    const lines = captureConsole(t, "log", "warn", "error");
    const u = updater as unknown as Record<string, unknown>;
    const realCheck = u.checkForUpdate;
    const realApply = u.applyUpdate;
    let applied = 0;
    u.checkForUpdate = async () => ({ behind: 1 });
    u.applyUpdate = async () => { applied++; };
    t.after(() => { u.checkForUpdate = realCheck; u.applyUpdate = realApply; });
    await (stageController as unknown as { updateCheckTick(): Promise<void> }).updateCheckTick();
    assert.equal(applied, 0);
    assert.equal(lines.filter((l) => l.startsWith("[stage-controller] auto-update waits:")).length, 1, lines.join("\n"));
  });

  it("applies at boot, before Planning Center has answered or any window is known", () => {
    // As before this change: nothing says a service is on, and waiting for
    // Planning Center would hold updates through an outage that began before boot.
    ctl.lastLive = null;
    serviceWindow.setWindows([]);
    assert.equal(stageController.shouldAutoApply(1, now).apply, true);
  });

  it("applies outside every cached window", async (t) => {
    serviceWindow.setWindows([{ open: now.getTime() + 86_400_000, close: now.getTime() + 90_000_000 }]);
    await liveReadFails(t);
    assert.equal(stageController.shouldAutoApply(1, now).apply, true);
  });
});

// A schedule that always falls in a window must not silently never apply: the
// update it declined is owed, and goes at the first check after the window closes.
describe("an update a service window held at its scheduled time", () => {
  // In Chicago: the window opens Thursday 26 Nov 17:00 (a rehearsal) and closes Sunday 29 Nov 13:15.
  const OPEN = Date.parse("2026-11-26T23:00:00Z");
  const CLOSE = Date.parse("2026-11-29T19:15:00Z");
  /** Sunday 29 Nov in Chicago, at `hh`:00. */
  const sunday = (hh: number) => new Date(Date.UTC(2026, 10, 29, hh + 6));
  const IN_AN_ITEM = { mode: "item", currentItemId: "item-1", serviceTimeStartsAt: sunday(14).toISOString(), liveStartAt: sunday(14).toISOString() };
  let applied: number;
  let lines: string[];
  const tick = (at: Date) => (stageController as unknown as { updateCheckTick(now: Date): Promise<void> }).updateCheckTick(at);

  /** Each test's world: called first in every test, with its own context, so the mocks undo with it. */
  function setup(t: TestContext): void {
    setAppTimeZone("America/Chicago");
    // No Planning Center credentials: the live reading counts as current, so only the window and "under way" hold it.
    ctl.pcoAppId = null;
    ctl.pcoSecret = null;
    ctl.lastLive = null;
    ctl.liveStale = false;
    ctl.state = { ...ctl.state, autoUpdate: { mode: "auto-full", dayOfWeek: 0, hour: 3 } };
    (stageController as unknown as { updateOwed: unknown }).updateOwed = null;
    serviceWindow.setWindows([{ open: OPEN, close: CLOSE }]);
    lines = captureConsole(t, "log", "warn", "error");
    const u = updater as unknown as Record<string, unknown>;
    const realCheck = u.checkForUpdate;
    const realApply = u.applyUpdate;
    applied = 0;
    u.checkForUpdate = async () => ({ behind: 1 });
    u.applyUpdate = async () => { applied++; };
    t.after(() => {
      u.checkForUpdate = realCheck;
      u.applyUpdate = realApply;
      setAppTimeZone(null);
      serviceWindow.setWindows([]);
    });
  }

  it("a Sunday 03:00 schedule inside a Thursday-to-Sunday-13:15 window applies at the first check after 13:15", async (t) => {
    setup(t);
    await tick(sunday(3));
    assert.equal(applied, 0, "applied inside the window");
    const owed = lines.filter((l) => l.startsWith("[stage-controller] auto-update waits:"));
    assert.deepEqual(owed, ["[stage-controller] auto-update waits: its scheduled time fell inside a planned service window, open until 13:15; it applies at the first check after the window closes, with no service under way"]);
    await tick(sunday(13));
    assert.equal(applied, 0, "applied before the window closed");
    assert.equal(lines.filter((l) => l.startsWith("[stage-controller] auto-update waits:")).length, 1, "said again on every check inside the window");
    await tick(sunday(14));
    assert.equal(applied, 1, "the owed update did not apply after the window closed: the schedule never applies");
    assert.ok(lines.includes("[stage-controller] auto-update applying late: what held it at its scheduled time is over"), lines.join("\n"));
    // Applied: nothing is owed, and the next check off-schedule does nothing.
    await tick(sunday(15));
    assert.equal(applied, 1);
  });

  it("does not apply while a service is under way after the window, and applies once it is not", async (t) => {
    setup(t);
    await tick(sunday(3));
    ctl.lastLive = IN_AN_ITEM;
    await tick(sunday(14));
    assert.equal(applied, 0, "applied through a service under way");
    ctl.lastLive = { ...IN_AN_ITEM, mode: "none", currentItemId: null };
    await tick(sunday(16));
    assert.equal(applied, 1);
  });

  it("a scheduled time a service ran over is owed too, said once, and applies once the service is over", async (t) => {
    setup(t);
    serviceWindow.setWindows([]);
    ctl.lastLive = IN_AN_ITEM;
    await tick(sunday(3));
    await tick(sunday(4));
    assert.equal(applied, 0, "applied through a service under way");
    const said = lines.filter((l) => l.startsWith("[stage-controller] auto-update waits:"));
    assert.deepEqual(said, ["[stage-controller] auto-update waits: a service is under way (A PCO service is live); it applies at the first check after it is not, outside a service window"]);
    ctl.lastLive = { ...IN_AN_ITEM, mode: "none", currentItemId: null };
    await tick(sunday(5));
    assert.equal(applied, 1, "the slot a service ran over was lost for the week");
  });

  it("is no longer owed once the mode goes manual", async (t) => {
    setup(t);
    await tick(sunday(3));
    ctl.state = { ...ctl.state, autoUpdate: { mode: "manual", dayOfWeek: 0, hour: 3 } };
    await tick(sunday(14));
    ctl.state = { ...ctl.state, autoUpdate: { mode: "auto-full", dayOfWeek: 0, hour: 3 } };
    await tick(sunday(15));
    assert.equal(applied, 0, "an update owed before the switch to manual applied after it");
  });

  it("is no longer owed once nothing is behind, even if a release comes out again", async (t) => {
    setup(t);
    await tick(sunday(3));
    const u = updater as unknown as Record<string, unknown>;
    u.checkForUpdate = async () => ({ behind: 0 });
    await tick(sunday(13));
    u.checkForUpdate = async () => ({ behind: 1 });
    await tick(sunday(14));
    assert.equal(applied, 0, "an update owed while behind applied a later release off its schedule, after nothing had been behind");
  });

  it("is no longer owed once the schedule changes: the new day and hour decide", async (t) => {
    setup(t);
    await tick(sunday(3));
    await stageController.setAutoUpdate({ hour: 5 });
    await tick(sunday(14));
    assert.equal(applied, 0, "an update owed by the old schedule applied off the new one");
    await stageController.setAutoUpdate({ hour: 3 });
    await tick(sunday(3));
    await stageController.setAutoUpdate({ dayOfWeek: 6 });
    await tick(sunday(15));
    assert.equal(applied, 0, "an update owed by the old day applied after the day changed");
  });
});

// A refresh whose plan reads fail must not erase the window around a service it
// read before: on a Sunday morning that window is all that holds the scheduled
// restart at 09:00 before a 10:00 service.
describe("a refresh whose plan reads fail keeps the windows it last read", () => {
  const hourNow = () => zonedParts(Date.now()).hour;
  function setup(t: TestContext): void {
    captureConsole(t, "log", "warn", "error");
    ctl.pcoAppId = "app";
    ctl.pcoSecret = "secret";
    ctl.lastLive = { mode: "none" };
    ctl.liveStale = false;
    ctl.state = { ...ctl.state, serviceTypeId: "1", planId: "p1", autoUpdate: { mode: "auto-full", dayOfWeek: null, hour: hourNow() } };
    (stageController as unknown as { updateOwed: unknown }).updateOwed = null;
    t.after(() => {
      Object.assign(pco, real);
      serviceWindow.setWindows([]);
    });
  }

  it("the scheduled hour before a service still waits when its times, or its plan list, fail to read again", async (t) => {
    setup(t);
    answering();
    await stageController.refreshServiceWindows();
    assert.deepEqual(stageController.shouldAutoApply(1, new Date()), { apply: false, why: "window" });
    answering({ times: "fail" });
    await stageController.refreshServiceWindows();
    assert.deepEqual(stageController.shouldAutoApply(1, new Date()), { apply: false, why: "window" }, "a failed read of the plan's times erased the window an hour before its service");
    answering({ plans: "fail" });
    await stageController.refreshServiceWindows();
    assert.deepEqual(stageController.shouldAutoApply(1, new Date()), { apply: false, why: "window" }, "a failed read of the plan list erased the window an hour before its service");
  });

  it("an owed update does not release mid-window through a failed read", async (t) => {
    setup(t);
    const u = updater as unknown as Record<string, unknown>;
    const realCheck = u.checkForUpdate;
    const realApply = u.applyUpdate;
    let applied = 0;
    u.checkForUpdate = async () => ({ behind: 1 });
    u.applyUpdate = async () => { applied++; };
    t.after(() => { u.checkForUpdate = realCheck; u.applyUpdate = realApply; });
    const tick = (at: Date) => (stageController as unknown as { updateCheckTick(now: Date): Promise<void> }).updateCheckTick(at);
    answering();
    await stageController.refreshServiceWindows();
    await tick(new Date());
    assert.equal(applied, 0);
    answering({ times: "fail" });
    await stageController.refreshServiceWindows();
    // A minute on, still inside the window: the failed read must not have opened a way through.
    await tick(new Date(Date.now() + 60_000));
    assert.equal(applied, 0, "the owed update applied inside the window its failed read had erased");
  });
});
