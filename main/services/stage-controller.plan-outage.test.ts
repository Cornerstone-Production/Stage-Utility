// Auto mode keeps the plan it follows while Planning Center cannot be read.
//
// selectGlobalNextPlan reads each allowed service type's upcoming plans and
// catches each type's failure, so one bad type does not stop the others. With
// every type failing it used to reach "no upcoming plans" and clear the plan:
// /patch, /stageplots and every slot board fell back to their defaults on one
// failed poll, and back again on the next good one. A read that failed for
// every type is a failed read, not an empty week.
//
// Planning Center is stubbed: it is the network. Driven through the real
// controller.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-plan-outage-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

const ctl = stageController as unknown as {
  state: Record<string, unknown>;
  pcoAppId: string | null;
  pcoSecret: string | null;
  broadcast: () => void;
};
const pco = pcoService as unknown as Record<string, unknown>;
const real = { listServiceTypes: pco.listServiceTypes, listUpcomingPlans: pco.listUpcomingPlans, getServiceEnd: pco.getServiceEnd };
const realBroadcast = ctl.broadcast;

let broadcasts = 0;
beforeEach(() => {
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.state = { ...ctl.state, allowedServiceTypeIds: [], serviceTypeId: "1", planId: "p-held", planTitle: "Held plan", planDates: "Nov 16" };
  broadcasts = 0;
  ctl.broadcast = () => {
    broadcasts++;
  };
  pco.listServiceTypes = async () => [
    { id: "1", name: "Sunday" },
    { id: "2", name: "Wednesday" },
  ];
  pco.getServiceEnd = async () => null;
});
after(async () => {
  Object.assign(pco, real);
  ctl.broadcast = realBroadcast;
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("selectGlobalNextPlan during an outage", () => {
  it("keeps the plan, and says why, when every service type's plans fail to read", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    pco.listUpcomingPlans = async () => {
      throw new Error("Planning Center returned 503");
    };
    await assert.rejects(stageController.selectGlobalNextPlan(), /could not read the upcoming plans of 2 of 2 service types/);
    assert.equal(ctl.state.planId, "p-held", "one failed poll cleared the plan the screens follow");
    assert.equal(broadcasts, 0, "a failed read broadcast a changed state");
    assert.ok(!lines.some((l) => l.includes("no upcoming plans found")), "a failed read was logged as an empty week");
  });

  it("keeps the plan when one type fails and the others answer with no plans", async (t) => {
    captureConsole(t, "log", "warn", "error");
    // The failed type may be the one whose plan the screens follow: an empty
    // answer from the others does not say the week is empty.
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [];
    };
    await assert.rejects(stageController.selectGlobalNextPlan(), /could not read the upcoming plans/);
    assert.equal(ctl.state.planId, "p-held", "a partial failure cleared the plan the screens follow");
    assert.equal(broadcasts, 0);
  });

  it("still clears the plan when Planning Center answers that no type has one", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.listUpcomingPlans = async () => [];
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, null);
  });

  it("follows the types that answered when only some fail", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [{ id: "p-wed", title: "Midweek", seriesTitle: null, sortDate: "2026-11-18T00:00:00Z", dates: "Nov 18" }];
    };
    (pco as Record<string, unknown>).listTeamMembers = async () => [];
    await stageController.selectGlobalNextPlan().catch(() => {});
    assert.equal(ctl.state.planId, "p-wed");
  });
});
