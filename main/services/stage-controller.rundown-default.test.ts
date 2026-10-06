// Whether a ScriptView rundown says it is the followed plan.
//
// `isDefaultPlan` is what lets the page tell Following from Browsing when it was
// handed a `planId`. upcoming-plans.test.ts pins the rule as a function; this
// pins that getScriptViewRundown actually USES it with the right inputs: the
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

const flag = async (typeId: string, planId?: string) => (await stageController.getScriptViewRundown(typeId, planId)).isDefaultPlan;

describe("getScriptViewRundown's isDefaultPlan", () => {
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

  it("an unknown plan comes back empty and still says it is the default, so the page reads planId null", async () => {
    const r = await stageController.getScriptViewRundown(OTHER, "nope");
    assert.equal(r.planId, null);
    assert.equal(r.isDefaultPlan, true);
  });
});
