// A failed note-category read degrades a rundown; it does not fail it.
//
// The canonical category list only ORDERS the rundown's columns: which columns there
// are comes from the items' own notes. When the categories read started to throw (so
// the note-categories route and Home's row could say Planning Center was down instead
// of "no categories"), the throw also took down every rundown that read them beside
// the items: the ServiceCue page, the public page's publisher, and the current plan's
// items. One failed request blanked a stage display whose items had been read.
//
// Driven through the real routes, the real controller and the publisher's own source.
// Only the pcoService reads are stubbed: they are the network.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-rundown-cats-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { serviceCueRoutes } = await import("./servicecue-routes.js");
const { historyRoutes } = await import("./history-routes.js");
const { stageController } = await import("../stage-controller.js");
const { pcoService } = await import("../pco-service.js");
const { appSource } = await import("../servicecue-publisher-instance.js");
const { callRoute } = await import("./route-harness.js");
const { captureConsole } = await import("../fixtures/capture-console.js");
const { OutageLog } = await import("../repeat-log.js");

type Mutable = {
  state: Record<string, unknown>;
  pcoAppId: string | null;
  pcoSecret: string | null;
  plansOutage: InstanceType<typeof OutageLog>;
  categoryOrder: Map<string, string[]>;
};
const ctl = stageController as unknown as Mutable;
const svc = pcoService as unknown as Record<string, unknown>;
const real = { ...svc };
const keptState = ctl.state;

const TYPE = "100";
const PLAN = "200";
const plan: PlanDTO = { id: PLAN, title: "Sunday", seriesTitle: null, sortDate: null, dates: null };
const item = (id: string, notes: Record<string, string>): PlanItemDTO => ({
  id, title: `Item ${id}`, itemType: "song", lengthSec: 0, sequence: Number(id), notesByCategory: notes, description: null,
});
// Vocals is first on the items, Audio first in Planning Center's own order.
const ITEMS = [item("1", { Vocals: "unison" }), item("2", { Audio: "two mics", Vocals: "harmony" })];

let categoriesFail = false;
let categoryReads = 0;

beforeEach(() => {
  categoriesFail = false;
  categoryReads = 0;
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.state = { ...keptState, serviceTypeId: TYPE, planId: PLAN };
  // Each test is its own outage, with no order read before it.
  ctl.plansOutage = new OutageLog();
  ctl.categoryOrder.clear();
  svc.listUpcomingPlans = async () => [plan];
  svc.listRecentPlans = async () => [];
  svc.listPlanItems = async () => ITEMS;
  svc.listItemNoteCategories = async () => {
    categoryReads++;
    if (categoriesFail) throw new Error("Planning Center returned 429");
    return ["Audio", "Vocals"];
  };
  svc.listPlanServiceTimes = async () => [];
  svc.listOrgTimeZone = async () => null;
  svc.listServiceTypes = async () => [];
});
afterEach(() => {
  Object.assign(svc, real);
  ctl.state = keptState;
});
after(() => fs.rm(TMP, { recursive: true, force: true }));

const rundownRoute = () => callRoute(serviceCueRoutes, `/api/servicecue/rundown?serviceTypeId=${TYPE}`, { method: "GET" });
const itemsRoute = () => callRoute(historyRoutes, "/api/pco/plan-items", { method: "GET" });

describe("a rundown whose note categories cannot be read", () => {
  it("still answers the ServiceCue page with its items and the columns they use", async (t) => {
    captureConsole(t, "warn", "log", "error");
    categoriesFail = true;
    const res = await rundownRoute();
    assert.equal(res.status, 200, `the rundown failed with the categories: ${JSON.stringify(res.json)}`);
    const body = res.json as ServiceCueRundownDTO;
    assert.deepEqual(body.items.map((i) => i.id), ["1", "2"]);
    // An empty list would answer 200 with every role column hidden (roleAppliesTo).
    assert.deepEqual([...body.noteCategories].sort(), ["Audio", "Vocals"]);
  });

  it("still answers the public page's publisher, which reads the same rundown", async (t) => {
    captureConsole(t, "warn", "log", "error");
    categoriesFail = true;
    const r = await appSource.rundown(TYPE, null);
    assert.deepEqual(r.items.map((i) => i.id), ["1", "2"]);
    assert.deepEqual([...r.noteCategories].sort(), ["Audio", "Vocals"]);
  });

  it("still answers the current plan's items", async (t) => {
    captureConsole(t, "warn", "log", "error");
    categoriesFail = true;
    const res = await itemsRoute();
    assert.equal(res.status, 200, `the plan items failed with the categories: ${JSON.stringify(res.json)}`);
    const body = res.json as PlanItemsDTO;
    assert.deepEqual(body.items.map((i) => i.id), ["1", "2"]);
    assert.deepEqual([...body.noteCategories].sort(), ["Audio", "Vocals"]);
  });

  it("keeps the last order Planning Center gave while the read fails, so columns do not reshuffle", async (t) => {
    captureConsole(t, "warn", "log", "error");
    assert.deepEqual((await appSource.rundown(TYPE, null)).noteCategories, ["Audio", "Vocals"]);
    categoriesFail = true;
    assert.deepEqual((await appSource.rundown(TYPE, null)).noteCategories, ["Audio", "Vocals"]);
    assert.deepEqual(((await itemsRoute()).json as PlanItemsDTO).noteCategories, ["Audio", "Vocals"]);
  });

  it("says so on [pco] once per outage, not once per poll", async (t) => {
    const lines = captureConsole(t, "warn", "log", "error");
    categoriesFail = true;
    await rundownRoute();
    await rundownRoute();
    await appSource.rundown(TYPE, null);
    await itemsRoute();
    const failed = lines.filter((l) => l.includes("[pco] note categories for service type"));
    assert.equal(failed.length, 1, `one outage, one line: ${JSON.stringify(lines)}`);
    assert.match(failed[0]!, /429/);
    assert.ok(categoryReads >= 4, "each rundown still asked: the hold is pco-service's, not this");
  });
});
