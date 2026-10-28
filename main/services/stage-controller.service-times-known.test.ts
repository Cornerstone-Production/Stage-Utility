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
const { pcoService } = await import("./pco-service.js");
const { serviceWindow } = await import("./service-window.js");
const { captureConsole } = await import("./fixtures/capture-console.js");
const { zonedParts } = await import("./app-timezone.js");
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

// The server's own updater (shouldAutoApply) asks the same question, but falls back
// on the cached service windows rather than waiting for Planning Center: a long
// outage must not hold every update.
describe("shouldAutoApply while the live state is unknown", () => {
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

  it("waits inside a cached service window", async (t) => {
    serviceWindow.setWindows([{ open: now.getTime() - 60_000, close: now.getTime() + 3_600_000 }]);
    assert.equal(stageController.shouldAutoApply(1, now).apply, true, "a current reading of nothing live, at the chosen hour");
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
