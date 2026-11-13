// Auto mode keeps the plan it follows while Planning Center cannot be read.
//
// selectGlobalNextPlan reads each allowed service type's upcoming plans and
// catches each type's failure, so one bad type does not stop the others. With
// every type failing it used to reach "no upcoming plans" and clear the plan:
// /patch, /stageplots and every slot board fell back to their defaults on one
// failed poll, and back again on the next good one. A read that failed for
// every type is a failed read, not an empty week.
//
// A partial failure is the same question one level down. When the type the
// followed plan belongs to cannot be read and another type answers with a plan,
// that answer says nothing about the followed plan: the controller holds it, and
// moves only on positive information, a plan another type reports LIVE now (in
// a plan item, near now: what a recorder would start on).
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
const { OutageLog } = await import("./repeat-log.js");

const ctl = stageController as unknown as {
  state: Record<string, unknown>;
  pcoAppId: string | null;
  pcoSecret: string | null;
  broadcast: () => void;
  lastLive: unknown;
  liveStale: boolean;
  plansOutage: InstanceType<typeof OutageLog>;
  autoAdvancedFromPlanId: string | null;
  rolloverRetry: unknown;
};
const pco = pcoService as unknown as Record<string, unknown>;
const real = {
  listServiceTypes: pco.listServiceTypes,
  listUpcomingPlans: pco.listUpcomingPlans,
  getServiceEnd: pco.getServiceEnd,
  getLive: pco.getLive,
  listTeamMembers: pco.listTeamMembers,
  listPersonPrepTags: pco.listPersonPrepTags,
};

const WED = { id: "p-wed", title: "Midweek", seriesTitle: null, sortDate: "2026-11-18T00:00:00Z", dates: "Nov 18" };

/** A live reading for a plan another type follows. `item` is a plan item running
 *  now; `preservice` is the countdown Planning Center gives every plan with a
 *  service time, which says nothing about whether it is happening. */
function liveReading(mode: "item" | "preservice" | "none", startsAt: string | null = new Date(Date.now() - 30 * 60_000).toISOString()) {
  return { mode, currentItemId: mode === "item" ? "item-1" : null, liveStartAt: null, serviceTimeStartsAt: startsAt };
}

let liveProbes: string[] = [];
const realBroadcast = ctl.broadcast;

let broadcasts = 0;
beforeEach(() => {
  ctl.pcoAppId = "app";
  ctl.pcoSecret = "secret";
  ctl.state = { ...ctl.state, allowedServiceTypeIds: [], serviceTypeId: "1", planId: "p-held", planTitle: "Held plan", planDates: "Nov 16", planMode: "auto" };
  ctl.autoAdvancedFromPlanId = null;
  ctl.rolloverRetry = null;
  ctl.lastLive = null;
  ctl.liveStale = false;
  // Settles at once, so a recovery is said on the first good read.
  ctl.plansOutage = new OutageLog(0);
  broadcasts = 0;
  liveProbes = [];
  ctl.broadcast = () => {
    broadcasts++;
  };
  pco.listServiceTypes = async () => [
    { id: "1", name: "Sunday" },
    { id: "2", name: "Wednesday" },
  ];
  pco.getServiceEnd = async () => null;
  pco.getLive = async (_a: string, _s: string, typeId: string, planId: string) => {
    liveProbes.push(`${typeId}:${planId}`);
    return liveReading("none");
  };
  pco.listTeamMembers = async () => [];
  pco.listPersonPrepTags = async () => [];
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

  // Changed with the hold: this used to pin the switch. The followed plan's own
  // type failing while another answers with a plan that is merely next now holds.
  it("holds the followed plan when its own type fails and another answers with a plan that is not live", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    // The countdown every plan with a service time gets: not live.
    pco.getLive = async (_a: string, _s: string, typeId: string, planId: string) => {
      liveProbes.push(`${typeId}:${planId}`);
      return liveReading("preservice");
    };
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-held", "a next plan from another type displaced the plan whose type failed");
    assert.equal(ctl.state.serviceTypeId, "1");
    assert.equal(broadcasts, 0, "a hold broadcast a changed state");
  });

  it("follows the types that answered when a type other than the followed plan's fails", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.listServiceTypes = async () => [
      { id: "1", name: "Sunday" },
      { id: "2", name: "Wednesday" },
      { id: "3", name: "Youth" },
    ];
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "3") throw new Error("Planning Center returned 503");
      if (typeId === "1") return [{ id: "p-sun", title: "Sunday", seriesTitle: null, sortDate: "2026-11-22T00:00:00Z", dates: "Nov 22" }];
      return [WED];
    };
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-wed");
    assert.deepEqual(liveProbes, [], "a poll with the followed type readable probed other types' live state");
  });

  it("switches to another type's plan when Planning Center reports it live now", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    pco.getLive = async (_a: string, _s: string, typeId: string, planId: string) => {
      liveProbes.push(`${typeId}:${planId}`);
      return liveReading("item");
    };
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-wed", "a plan live now on another type did not displace the held plan");
    assert.equal(ctl.state.serviceTypeId, "2");
  });

  it("holds when another type's plan is in an item but its service is days away", async (t) => {
    captureConsole(t, "log", "warn", "error");
    // Somebody stepping through next week's plan in Planning Center Live.
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    pco.getLive = async () => liveReading("item", new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString());
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-held", "a plan stepped through days ahead displaced the held plan");
  });

  it("holds, and says so, when another type's live state cannot be read", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    pco.getLive = async () => {
      throw new Error("Planning Center returned 429");
    };
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-held", "an unreadable live state was taken as live");
    assert.ok(
      lines.some((l) => l.includes("[plans]") && l.includes("Planning Center returned 429")),
      `the failed live read went unsaid: ${lines.join(" | ")}`,
    );
  });

  it("keeps the followed plan while it is itself live, whatever another type reports", async (t) => {
    captureConsole(t, "log", "warn", "error");
    // Switching away from a running service would stop its recording.
    ctl.lastLive = liveReading("item");
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    pco.getLive = async (_a: string, _s: string, typeId: string, planId: string) => {
      liveProbes.push(`${typeId}:${planId}`);
      return liveReading("item");
    };
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-held", "a second live service displaced the followed one mid-service");
  });

  it("does not hold for a type the operator no longer allows", async (t) => {
    captureConsole(t, "log", "warn", "error");
    ctl.state = { ...ctl.state, allowedServiceTypeIds: ["2"] };
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-wed");
  });

  it("says the hold once, not once per poll, and says when it ends", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    let sundayDown = true;
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") {
        if (sundayDown) throw new Error("Planning Center returned 503");
        return [{ id: "p-held", title: "Held plan", seriesTitle: null, sortDate: "2026-11-16T00:00:00Z", dates: "Nov 16" }];
      }
      return [WED];
    };
    await stageController.selectGlobalNextPlan();
    await stageController.selectGlobalNextPlan();
    await stageController.selectGlobalNextPlan();
    const holds = lines.filter((l) => l.includes("[plans] holding the followed plan"));
    assert.equal(holds.length, 1, `the hold was said ${holds.length} times over three polls`);
    sundayDown = false;
    await stageController.selectGlobalNextPlan();
    await stageController.selectGlobalNextPlan();
    const ends = lines.filter((l) => l.includes("[plans]") && l.includes("can be read again"));
    assert.equal(ends.length, 1, `the end of the hold was said ${ends.length} times: ${lines.join(" | ")}`);
    assert.equal(ctl.state.planId, "p-held");
  });

  it("keeps the followed plan when its own live reading went stale while its service is near now", async (t) => {
    captureConsole(t, "log", "warn", "error");
    // The followed type failing is exactly when its live read fails too.
    ctl.lastLive = liveReading("item");
    ctl.liveStale = true;
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    pco.getLive = async () => liveReading("item");
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-held", "a stale reading of a followed plan in a live item let another live plan displace it");
  });

  it("does not count a stale live reading from a service days ago", async (t) => {
    captureConsole(t, "log", "warn", "error");
    ctl.lastLive = liveReading("item", new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString());
    ctl.liveStale = true;
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    pco.getLive = async () => liveReading("item");
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-wed", "a two-day-old live reading kept the followed plan from a service live now");
  });
});

describe("a followed plan that is already over", () => {
  const ENDED = () => new Date(Date.now() - 3 * 60 * 60_000).toISOString();

  it("is not held while its type cannot be read", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.getServiceEnd = async (_a: string, _s: string, _t: string, planId: string) => (planId === "p-held" ? ENDED() : null);
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, "p-wed", "a plan that ended three hours ago was held over the next one");
  });

  it("is not kept by a failed type when its own type says it is over", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.listServiceTypes = async () => [
      { id: "1", name: "Sunday" },
      { id: "2", name: "Wednesday" },
      { id: "3", name: "Youth" },
    ];
    pco.getServiceEnd = async () => ENDED();
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "3") throw new Error("Planning Center returned 503");
      if (typeId === "1") return [{ id: "p-held", title: "Held plan", seriesTitle: null, sortDate: "2026-11-16T00:00:00Z", dates: "Nov 16" }];
      return [];
    };
    await stageController.selectGlobalNextPlan();
    assert.equal(ctl.state.planId, null, "an ended plan was kept because an unrelated type failed");
  });

  it("rolls over to the next plan while its type cannot be read", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.getServiceEnd = async (_a: string, _s: string, _t: string, planId: string) => (planId === "p-held" ? ENDED() : null);
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    await stageController.maybeAutoAdvance();
    assert.equal(ctl.state.planId, "p-wed", "the rollover held the plan that had ended");
  });

  it("a rollover that moves nothing is tried again, after a backoff, not on every tick", async (t) => {
    captureConsole(t, "log", "warn", "error");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    pco.getServiceEnd = async (_a: string, _s: string, _t: string, planId: string) => (planId === "p-held" ? new Date(now - 3 * 60 * 60_000).toISOString() : null);
    let typeReads = 0;
    let down = true;
    pco.listServiceTypes = async () => {
      typeReads++;
      if (down) throw new Error("Planning Center returned 503");
      return [{ id: "1", name: "Sunday" }, { id: "2", name: "Wednesday" }];
    };
    pco.listUpcomingPlans = async () => [WED];

    await stageController.maybeAutoAdvance();
    assert.equal(ctl.state.planId, "p-held");
    assert.equal(typeReads, 1);
    await stageController.maybeAutoAdvance();
    assert.equal(typeReads, 1, "a rollover that failed was tried again on the very next tick");

    now += 61_000;
    await stageController.maybeAutoAdvance();
    assert.equal(typeReads, 2, "a rollover that moved nothing was spent, and never tried again");

    now += 61_000;
    await stageController.maybeAutoAdvance();
    assert.equal(typeReads, 2, "the second retry did not back off further");

    down = false;
    now += 2 * 61_000;
    await stageController.maybeAutoAdvance();
    assert.equal(ctl.state.planId, "p-wed", "the retry did not roll over once Planning Center answered");
  });
});

describe("a rollover that cannot move", () => {
  /** A rollover from an ended plan while every service type fails, with the
   *  clock under the test's hand. Returns the clock and how often the types were asked. */
  function failingRollover(t: { mock: { method: (o: object, n: string, f: () => number) => unknown } }) {
    const clock = { now: Date.now(), typeReads: 0, down: true };
    t.mock.method(Date, "now", () => clock.now);
    pco.getServiceEnd = async (_a: string, _s: string, _t: string, planId: string) =>
      planId === "p-held" ? new Date(clock.now - 3 * 60 * 60_000).toISOString() : null;
    pco.listServiceTypes = async () => {
      clock.typeReads++;
      if (clock.down) throw new Error("Planning Center returned 503");
      return [{ id: "1", name: "Sunday" }, { id: "2", name: "Wednesday" }];
    };
    pco.listUpcomingPlans = async () => [WED];
    return clock;
  }

  it("waits no more than fifteen minutes between tries, however long it fails", async (t) => {
    captureConsole(t, "log", "warn", "error");
    const clock = failingRollover(t);
    await stageController.maybeAutoAdvance();
    // Waits of 60, 120, 240 and 480 s; the fifth would be 960 s uncapped.
    for (const wait of [60, 120, 240, 480]) {
      clock.now += wait * 1000 + 1000;
      await stageController.maybeAutoAdvance();
    }
    assert.equal(clock.typeReads, 5);
    clock.now += 15 * 60_000 + 1000;
    await stageController.maybeAutoAdvance();
    assert.equal(clock.typeReads, 6, "the wait between tries grew past fifteen minutes");
  });

  it("tries again at once when Planning Center's live state is known again", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    const clock = failingRollover(t);
    await stageController.maybeAutoAdvance();
    for (const wait of [60, 120, 240]) {
      clock.now += wait * 1000 + 1000;
      await stageController.maybeAutoAdvance();
    }
    assert.equal(clock.typeReads, 4);
    // Planning Center answers the live poller again.
    ctl.liveStale = true;
    pco.getLive = async () => liveReading("none");
    await stageController.fetchLive();
    assert.ok(lines.some((l) => l.includes("[pco] live state known again")));
    clock.down = false;
    clock.now += 1000;
    await stageController.maybeAutoAdvance();
    assert.equal(ctl.state.planId, "p-wed", "the rollover waited out its backoff after Planning Center answered again");
  });
});

describe("an explicit refresh during a hold", () => {
  it("says the plan is held, rather than reporting a refresh that read nothing", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    await assert.rejects(
      stageController.refresh(true),
      /holding the followed plan: Sunday could not be read — Planning Center returned 503/,
    );
    assert.equal(ctl.state.planId, "p-held");
  });

  it("while the unattended refresh tick holds quietly", async (t) => {
    captureConsole(t, "log", "warn", "error");
    pco.listUpcomingPlans = async (_a: string, _s: string, typeId: string) => {
      if (typeId === "1") throw new Error("Planning Center returned 503");
      return [WED];
    };
    await stageController.refresh(false);
    assert.equal(ctl.state.planId, "p-held");
  });
});
