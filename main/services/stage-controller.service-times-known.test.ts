// Whether the service times are known well enough to restart a Mac helper's
// outputs on (machine-updates.ts). Not knowing must never read as "nothing is
// on": right after the server starts, while Planning Center fails, and when only
// some of a schedule could be read.
//
// Planning Center is stubbed: it is the network. What is pinned is what
// refreshServiceWindows and serviceTimesKnown make of what it answers.

import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-service-times-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");
const { serviceWindow } = await import("./service-window.js");

type Mutable = {
  state: Record<string, unknown>;
  pcoAppId: string | null;
  pcoSecret: string | null;
  lastLive: unknown;
};
const ctl = stageController as unknown as Mutable;
const pco = pcoService as unknown as Record<string, unknown>;
const real = { listServiceTypes: pco.listServiceTypes, listUpcomingPlans: pco.listUpcomingPlans, listPlanTimes: pco.listPlanTimes };

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
});
