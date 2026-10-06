// Whether a ServiceCue rundown says it is the followed plan.
//
// `isDefaultPlan` is what lets the page tell Following from Browsing when it was
// handed a `planId`. upcoming-plans.test.ts pins the rule as a function; this
// pins that getServiceCueRundown actually USES it with the right inputs: the
// controller's own plan on the active type, the nearest upcoming plan on any
// other, and the request's planId. A page that was always told "default" would
// never say Browsing for a real plan, and the page's own tests answer with a
// fetch stub that hard-codes the flag, so they cannot see this.
//
// Driven through the real controller against a real temp data dir. Only the
// pcoService reads are stubbed: they are the network.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-rundown-default-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

type Mutable = {
  state: Record<string, unknown>;
  pcoAppId: string | null;
  pcoSecret: string | null;
};
const ctl = stageController as unknown as Mutable;

const ACTIVE = "st-active";
const OTHER = "st-other";
const plan = (id: string): PlanDTO => ({ id, title: id, seriesTitle: null, sortDate: null, dates: null });

const svc = pcoService as unknown as Record<string, unknown>;
const real = { ...svc };

before(() => {
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.state = { ...ctl.state, serviceTypeId: ACTIVE, planId: "p2" };
  // p1 is the nearest upcoming plan of both types; p2 is the app's own on ACTIVE.
  svc.listUpcomingPlans = async () => [plan("p1"), plan("p2"), plan("p3")];
  svc.listRecentPlans = async () => [];
  svc.listPlanItems = async () => [];
  svc.listItemNoteCategories = async () => [];
  svc.listPlanServiceTimes = async () => [];
  svc.listOrgTimeZone = async () => null;
  svc.listServiceTypes = async () => [];
});

after(async () => {
  Object.assign(svc, real);
  await fs.rm(TMP, { recursive: true, force: true });
});

const flag = async (typeId: string, planId?: string) => (await stageController.getServiceCueRundown(typeId, planId)).isDefaultPlan;

describe("getServiceCueRundown's isDefaultPlan", () => {
  it("is true with no planId, on the active type and on another", async () => {
    assert.equal(await flag(ACTIVE), true);
    assert.equal(await flag(OTHER), true);
  });

  it("on the active type, true for the app's plan and false for any other", async () => {
    assert.equal(await flag(ACTIVE, "p2"), true);
    assert.equal(await flag(ACTIVE, "p1"), false, "the nearest plan is not the followed one on the active type");
    assert.equal(await flag(ACTIVE, "p3"), false);
  });

  it("on another type, true for the nearest upcoming plan and false for any other", async () => {
    assert.equal(await flag(OTHER, "p1"), true);
    assert.equal(await flag(OTHER, "p2"), false, "the app's plan id means nothing on a type the app is not on");
  });

  it("when the app's own plan no longer resolves, the nearest upcoming plan is what the default falls to", async () => {
    // With no planId the rundown answers with plans[0] here, so a page browsing
    // plans[0] is looking at the followed plan, and one browsing the vanished
    // plan's neighbour is not.
    const kept = ctl.state;
    ctl.state = { ...kept, planId: "gone" };
    try {
      assert.equal((await stageController.getServiceCueRundown(ACTIVE)).planId, "p1");
      assert.equal(await flag(ACTIVE, "p1"), true, "the plan the default resolves to was labelled Browsing");
      assert.equal(await flag(ACTIVE, "p2"), false);
    } finally {
      ctl.state = kept;
    }
  });

  it("a browse request still answers when the followed plan's own read fails, and says so once", async (t) => {
    // Resolving the followed plan to label the page reaches the recent-plans list
    // when the app's plan is not in the upcoming one. That read is not what the
    // request asked for: a plan named in the request that IS in the upcoming list
    // answered before the label followed the default, and must not start to 502.
    const lines = captureConsole(t, "warn");
    const kept = ctl.state;
    const keptRecent = svc.listRecentPlans;
    ctl.state = { ...kept, planId: "gone" };
    svc.listRecentPlans = async () => {
      throw new Error("Planning Center returned 503");
    };
    try {
      const first = await stageController.getServiceCueRundown(ACTIVE, "p1");
      assert.equal(first.planId, "p1", "the request named a plan in the upcoming list and must be answered");
      assert.equal(first.isDefaultPlan, false, "compared against the app's own plan when the default could not be resolved");
      const again = await stageController.getServiceCueRundown(ACTIVE, "p3");
      assert.equal(again.planId, "p3");
      assert.equal(
        lines.filter((l) => l.includes("[plans] could not resolve the followed plan")).length,
        1,
        `one outage, one line: ${JSON.stringify(lines)}`,
      );
      // With no planId the followed plan IS the answer, so its failure still propagates.
      await assert.rejects(() => stageController.getServiceCueRundown(ACTIVE), /503/);
    } finally {
      ctl.state = kept;
      svc.listRecentPlans = keptRecent;
    }
  });

  it("an unknown plan comes back empty and still says it is the default, so the page reads planId null", async () => {
    const r = await stageController.getServiceCueRundown(OTHER, "nope");
    assert.equal(r.planId, null);
    assert.equal(r.isDefaultPlan, true);
  });
});
