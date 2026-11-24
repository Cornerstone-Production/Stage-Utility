// Three Planning Center reads that parsed a failure into an empty answer, and what each
// consumer now does with the failure instead.
//
// Team names, plan times and the organization's time zone each caught a failed request
// and answered "none": no teams for the checklist picker, no plan times, no zone. Nothing
// said so, and the reconnect windows' own gap check could never fire, because a failed
// plan-times read looked like a plan with no times. They now throw (held for
// TTL_FAILED_MS, as a failure), and each caller decides: the picker's route answers 502,
// the reconnect windows count the gap, the rundown and the live reading answer without
// them and say so once on [pco].
//
// Driven through the real controller, routes and pcoService. Only pcoService's request
// (the network) and the plan reads the tests do not exercise are stubbed.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-pco-failed-reads-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { historyRoutes } = await import("./routes/history-routes.js");
const { stageController } = await import("./stage-controller.js");
const { pcoService } = await import("./pco-service.js");
const { serviceWindow } = await import("./service-window.js");
const { callRoute } = await import("./routes/route-harness.js");
const { captureConsole } = await import("./fixtures/capture-console.js");
const { OutageLog } = await import("./repeat-log.js");
const { appTimeZone } = await import("./app-timezone.js");
const { appSource } = await import("./servicecue-publisher-instance.js");

type Mutable = {
  state: Record<string, unknown>;
  pcoAppId: string | null;
  pcoSecret: string | null;
  plansOutage: InstanceType<typeof OutageLog>;
  rundownLastGood: Map<string, unknown>;
};
const ctl = stageController as unknown as Mutable;
const svc = pcoService as unknown as Record<string, unknown>;
const real = { ...svc, request: svc.request };
const keptState = ctl.state;

const TYPE = "100";
const PLAN = "200";
const plan: PlanDTO = { id: PLAN, title: "Sunday", seriesTitle: null, sortDate: null, dates: null };
const SOON = new Date(Date.now() + 60 * 60_000).toISOString();

/** Which reads fail, by a piece of their path. */
let failing: string[] = [];
let asked: string[] = [];

beforeEach(() => {
  failing = [];
  asked = [];
  pcoService.clearCache();
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.state = { ...keptState, serviceTypeId: TYPE, planId: PLAN, allowedServiceTypeIds: [] };
  ctl.plansOutage = new OutageLog();
  ctl.rundownLastGood.clear();
  svc.listUpcomingPlans = async () => [plan];
  svc.listRecentPlans = async () => [];
  svc.listPlanItems = async () => [];
  svc.listItemNoteCategories = async () => [];
  svc.listServiceTypes = async () => [{ id: TYPE, name: "Sunday", itemTypeColors: [] }];
  svc.request = async (url: string) => {
    const u = String(url);
    asked.push(u);
    if (failing.some((f) => u.includes(f))) throw new Error("Planning Center returned 503");
    if (u.includes("/plan_note_categories")) return { data: [{ id: "1", type: "PlanNoteCategory", attributes: { name: "Tech", sequence: 0 } }] };
    if (u.includes("/teams")) return { data: [{ id: "1", type: "Team", attributes: { name: "Band" } }] };
    if (u.includes("/plan_times")) {
      return { data: [{ id: "9", type: "PlanTime", attributes: { name: "9am", time_type: "service", starts_at: SOON, ends_at: null } }] };
    }
    if (u.includes("/live")) return { data: { id: PLAN, type: "Live", attributes: {}, relationships: {} }, included: [] };
    // The organization itself: the time zone.
    return { data: { id: "1", type: "Organization", attributes: { time_zone: "America/Chicago" } } };
  };
});
afterEach(() => {
  Object.assign(svc, real);
  ctl.state = keptState;
});
after(() => fs.rm(TMP, { recursive: true, force: true }));

describe("team names", () => {
  it("a failed read is 502 on the checklist picker's route, never a picker with no teams", async (t) => {
    const lines = captureConsole(t, "warn", "log", "error");
    failing = ["/teams"];
    const res = await callRoute(historyRoutes, "/api/pco/checklist-sources", { method: "GET" });
    assert.equal(res.status, 502, `answered as if the service type had no teams: ${JSON.stringify(res.json)}`);
    assert.match(lines.join("\n"), /\[pco\] checklist sources read failed/);
  });

  it("answers the teams when Planning Center does", async () => {
    const res = await callRoute(historyRoutes, "/api/pco/checklist-sources", { method: "GET" });
    assert.deepEqual(res.json, { categories: ["Tech"], teams: ["Band"] });
  });
});

describe("plan times", () => {
  it("a failed read leaves the reconnect windows unknown, not 'nothing planned'", async (t) => {
    captureConsole(t, "warn", "log", "error");
    failing = ["/plan_times"];
    serviceWindow.setWindows([]);
    await stageController.refreshServiceWindows();
    assert.equal(serviceWindow.isKnown(), false, "a plan whose times could not be read counted as a plan with none");
  });

  it("a rundown still answers without them, and says so once on [pco]", async (t) => {
    const lines = captureConsole(t, "warn", "log", "error");
    failing = ["/plan_times"];
    const first = await stageController.getServiceCueRundown(TYPE);
    await stageController.getServiceCueRundown(TYPE);
    assert.equal(first.planId, PLAN);
    assert.deepEqual(first.serviceTimes, []);
    const said = lines.filter((l) => l.includes("[pco] service times for service type"));
    assert.equal(said.length, 1, `one outage, one line: ${JSON.stringify(lines)}`);
  });

  it("the live reading still answers without them, its service time unknown, said once", async (t) => {
    const lines = captureConsole(t, "warn", "log", "error");
    failing = ["/plan_times"];
    const live = await pcoService.getLive("app", "secret", TYPE, PLAN);
    await pcoService.getLive("app", "secret", TYPE, PLAN);
    assert.equal(live.serviceTimeId ?? null, null);
    const said = lines.filter((l) => l.includes("[pco] plan times unavailable to the live reading"));
    assert.equal(said.length, 1, `one outage, one line: ${JSON.stringify(lines)}`);
  });

  it("a failure is held, not asked again on every tick", async (t) => {
    captureConsole(t, "warn", "log", "error");
    failing = ["/plan_times"];
    await pcoService.getLive("app", "secret", TYPE, PLAN);
    await pcoService.getLive("app", "secret", TYPE, PLAN);
    await pcoService.getLive("app", "secret", TYPE, PLAN);
    assert.equal(asked.filter((u) => u.includes("/plan_times")).length, 1);
  });
});

describe("the organization's time zone", () => {
  it("a failed read, with none read before, leaves a rundown in this server's zone, said once on [pco], and held", async (t) => {
    const lines = captureConsole(t, "warn", "log", "error");
    // The organization is the API root: matched on the bare root URL exactly.
    svc.request = ((inner) => async (url: string) => {
      if (/\/services\/v2\/?$/.test(String(url))) {
        asked.push(String(url));
        throw new Error("Planning Center returned 503");
      }
      return inner(url);
    })(svc.request as (url: string) => Promise<unknown>);
    const first = await stageController.getServiceCueRundown(TYPE);
    await stageController.getServiceCueRundown(TYPE);
    assert.equal(first.timeZone, appTimeZone());
    assert.equal(lines.filter((l) => l.includes("[pco] the time zone could not be read")).length, 1, JSON.stringify(lines));
    assert.equal(asked.filter((u) => /\/services\/v2\/?$/.test(u)).length, 1, "every rundown asked again");
  });
});

describe("service types, read for a rundown's row colours", () => {
  it("a failed read leaves the rundown without row colours, never failed", async (t) => {
    const lines = captureConsole(t, "warn", "log", "error");
    svc.listServiceTypes = async () => {
      throw new Error("Planning Center returned 503");
    };
    const r = await stageController.getServiceCueRundown(TYPE);
    assert.equal(r.planId, PLAN);
    assert.deepEqual(r.itemTypeColors, []);
    assert.equal(lines.filter((l) => l.includes("[pco] service types could not be read")).length, 1, JSON.stringify(lines));
  });
});

// What the public page's publisher reads: it keeps its last good copy only for a FAILED read,
// so a rundown that answers emptied of a part would replace a good public page with one in the
// wrong zone, without its projected clock or row colours.
describe("a part that fails after a good read", () => {
  const COLOURS = [{ id: TYPE, name: "Sunday", itemTypeColors: [{ itemType: "song", color: "#123456" }] }];

  it("answers with its last good value, so the publisher's copy is not replaced by an emptied one", async (t) => {
    const lines = captureConsole(t, "warn", "log", "error");
    svc.listServiceTypes = async () => COLOURS;
    const good = await appSource.rundown(TYPE, null);
    assert.deepEqual(good.serviceTimes, [SOON]);
    assert.equal(good.timeZone, "America/Chicago");
    assert.equal(good.itemTypeColors?.length, 1);

    // Each part fails, past its hold (the cache is cleared, so each read asks).
    pcoService.clearCache();
    failing = ["/plan_times"];
    svc.request = ((inner) => async (url: string) => {
      if (/\/services\/v2\/?$/.test(String(url))) throw new Error("Planning Center returned 503");
      return inner(url);
    })(svc.request as (url: string) => Promise<unknown>);
    svc.listServiceTypes = async () => {
      throw new Error("Planning Center returned 503");
    };
    const degraded = await appSource.rundown(TYPE, null);
    assert.deepEqual(degraded, good, "a degraded rundown is not the one last served");
    assert.ok(lines.some((l) => l.includes("rundowns still answer, with the service times last read")), JSON.stringify(lines));
  });
});

describe("what heldRead holds", () => {
  it("an organization with no time zone set is asked once, not on every rundown", async () => {
    svc.request = async (url: string) => {
      asked.push(String(url));
      return { data: { id: "1", type: "Organization", attributes: {} } };
    };
    assert.equal(await pcoService.listOrgTimeZone("app", "secret"), null);
    assert.equal(await pcoService.listOrgTimeZone("app", "secret"), null);
    assert.equal(asked.length, 1, "a null answer was read back as a miss and asked for again");
  });

  it("a failed service-types read is held, not asked again by every caller", async () => {
    // The real read, not the stub beforeEach puts in its place.
    delete svc.listServiceTypes;
    svc.request = async (url: string) => {
      asked.push(String(url));
      throw new Error("Planning Center returned 429");
    };
    await assert.rejects(pcoService.listServiceTypes("app", "secret"), /429/);
    await assert.rejects(pcoService.listServiceTypes("app", "secret"), /429/);
    assert.equal(asked.length, 1, "a failed service-types read was asked again inside the hold");
  });
});
