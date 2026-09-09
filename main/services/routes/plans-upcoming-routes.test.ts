// GET /api/plans/upcoming, driven through the real handler.
//
// The plan switcher in the slot editor walks this list, so its shape, its
// window, its order and — above all — what it answers when Planning Center is
// unreachable are what decide whether an operator can still edit the board on
// screen during an outage. A 5xx there would read as "this app is broken" while
// the editor was in fact perfectly usable.
//
// Planning Center is never contacted: `listServiceTypes` and `listPlans` on the
// controller singleton are replaced, which is exactly the seam the route calls
// through.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-plans-upcoming-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stateRoutes } = await import("./state-routes.js");
const { viewRoutes } = await import("./view-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type Mutable = {
  state: Record<string, unknown>;
  broadcast: () => void;
  // Typed rather than `unknown`, so a change to the cache's shape — the allowlist
  // joined its key — fails tsc here instead of throwing at runtime inside a case
  // about something else entirely.
  upcomingCache: { at: number; days: number; allowed: string[]; plans: UpcomingPlan[] } | null;
  listServiceTypes: () => Promise<ServiceTypeDTO[]>;
  listPlans: (serviceTypeId: string) => Promise<PlanDTO[]>;
};
const ctl = stageController as unknown as Mutable;

/** A plan `days` from now, so every case sits in the window relative to the real
 *  clock rather than a date that ages out of it. */
function plan(id: string, days: number, title = id): PlanDTO {
  return {
    id,
    title,
    seriesTitle: null,
    sortDate: new Date(NOW + days * DAY).toISOString(),
    dates: `day ${days}`,
  };
}

const TYPES: ServiceTypeDTO[] = [
  { id: "st-sun", name: "Sunday" },
  { id: "st-youth", name: "Youth" },
];

/** Per-type answers the fake `listPlans` serves; a case rewrites this. */
let byType: Record<string, PlanDTO[] | Error> = {};

before(() => {
  ctl.broadcast = () => {};
  ctl.listServiceTypes = async () => TYPES;
  ctl.listPlans = async (id: string) => {
    const answer = byType[id] ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  };
});

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  ctl.state = {
    ...ctl.state,
    serviceTypeId: "st-sun",
    serviceTypeName: "Sunday",
    planId: "sun-now",
    planDates: "September 13, 2026",
    allowedServiceTypeIds: [],
    views: [],
    outputs: [],
  };
  ctl.upcomingCache = null;
  byType = {
    "st-sun": [plan("sun-now", 5, "Sunday morning"), plan("sun-next", 12, "Sunday morning")],
    "st-youth": [plan("youth-next", 2, "Youth night")],
  };
});

describe("GET /api/plans/upcoming", () => {
  it("returns every allowed type's plans, in date order, with the type on each row", async () => {
    const r = await callRoute(stateRoutes, "/api/plans/upcoming?days=60");
    assert.equal(r.status, 200);
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(
      body.plans.map((p) => [p.planId, p.serviceTypeId, p.serviceTypeName]),
      [
        ["youth-next", "st-youth", "Youth"],
        ["sun-now", "st-sun", "Sunday"],
        ["sun-next", "st-sun", "Sunday"],
      ],
      "the arrows walk the week across types, so Wednesday's youth plan comes before Sunday's",
    );
    assert.equal(body.unavailable, undefined);
  });

  it("flags the plan the machine is following", async () => {
    const r = await callRoute(stateRoutes, "/api/plans/upcoming");
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(
      body.plans.filter((p) => p.isCurrent).map((p) => p.planId),
      ["sun-now"],
    );
  });

  it("honours the allowlist", async () => {
    ctl.state.allowedServiceTypeIds = ["st-youth"];
    const r = await callRoute(stateRoutes, "/api/plans/upcoming");
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(body.plans.map((p) => p.serviceTypeId), ["st-youth"]);
  });

  it("drops a plan outside the window and keeps one from last week", async () => {
    byType["st-sun"] = [
      plan("sun-now", 5),
      plan("sun-last-week", -3),
      plan("sun-last-year", -300),
      plan("sun-far", 200),
    ];
    byType["st-youth"] = [];
    const r = await callRoute(stateRoutes, "/api/plans/upcoming?days=60");
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(
      body.plans.map((p) => p.planId),
      ["sun-last-week", "sun-now"],
      "the window is the last seven days plus the next sixty",
    );
  });

  it("obeys ?days", async () => {
    byType["st-sun"] = [plan("sun-now", 5), plan("sun-far", 40)];
    byType["st-youth"] = [];
    const r = await callRoute(stateRoutes, "/api/plans/upcoming?days=10");
    assert.deepEqual((r.json as UpcomingPlansDTO).plans.map((p) => p.planId), ["sun-now"]);
  });

  it("ignores a nonsense ?days rather than answering an empty list", async () => {
    const r = await callRoute(stateRoutes, "/api/plans/upcoming?days=banana");
    assert.equal((r.json as UpcomingPlansDTO).plans.length, 3);
  });

  // `?days=0.5` cleared the `> 0` test and floored to zero afterwards, so the
  // window was a single day: the switcher offered tonight and nothing else, with
  // no sign anything was wrong. Anything under a whole day is nonsense and takes
  // the default, the same answer `?days=banana` gets.
  it("treats a fractional ?days as nonsense rather than a one-day window", async () => {
    byType["st-sun"] = [plan("sun-now", 5), plan("sun-far", 40)];
    byType["st-youth"] = [];
    const r = await callRoute(stateRoutes, "/api/plans/upcoming?days=0.5");
    assert.deepEqual(
      (r.json as UpcomingPlansDTO).plans.map((p) => p.planId),
      ["sun-now", "sun-far"],
      "0.5 floors to 0, and a zero-day window is not what anyone asked for — the default 60 is",
    );
  });

  it("reports the cache age, in the body and in a header", async () => {
    const first = await callRoute(stateRoutes, "/api/plans/upcoming");
    assert.equal((first.json as UpcomingPlansDTO).cacheAgeMs, 0, "a fresh read is not cached");
    assert.equal(first.headers["X-Plans-Cache-Age-Ms"], "0");

    // The second read must not reach the fake at all — that is what the cache is
    // for, and a quota spent per switcher open is what it exists to avoid.
    byType["st-youth"] = new Error("should not be asked again");
    const second = await callRoute(stateRoutes, "/api/plans/upcoming");
    const body = second.json as UpcomingPlansDTO;
    assert.equal(body.plans.length, 3);
    assert.ok(body.cacheAgeMs >= 0);
    assert.equal(body.unavailable, undefined);
  });
});

// The list is BUILT from the allowlist and cached for five minutes, so a type
// ticked on the Plan page was missing from the switcher for up to five minutes,
// and a type ticked off lingered in it — where stepping onto one of its plans
// wrote a real override for a service type the operator had just turned off.
describe("when the allowlist changes", () => {
  it("the next list call refetches instead of serving the old allowlist's answer", async () => {
    ctl.state.planMode = "manual"; // no background PCO re-selection sweep
    const first = await callRoute(stateRoutes, "/api/plans/upcoming");
    assert.equal((first.json as UpcomingPlansDTO).plans.length, 3);

    await stageController.setAllowedServiceTypes(["st-youth"]);

    const second = await callRoute(stateRoutes, "/api/plans/upcoming");
    const body = second.json as UpcomingPlansDTO;
    assert.deepEqual(
      body.plans.map((p) => p.planId),
      ["youth-next"],
      "a switcher still walking a type the operator turned off saves overrides nothing will ever read",
    );
    assert.equal(body.cacheAgeMs, 0, "and it really refetched rather than filtering a stale list");
  });

  // The two halves are not the same guard. Keying on the allowlist stops a stale
  // entry being served on the FRESH path; dropping the entry outright is what
  // stops it being served on the UNAVAILABLE path, which hands back the last good
  // list whatever its key. Without the clear, turning a service type off and then
  // losing Planning Center left the switcher still walking that type's plans.
  it("and a Planning Center outage right afterwards does not resurrect the old list", async () => {
    ctl.state.planMode = "manual";
    await callRoute(stateRoutes, "/api/plans/upcoming");
    await stageController.setAllowedServiceTypes(["st-youth"]);

    const real = ctl.listServiceTypes;
    ctl.listServiceTypes = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    try {
      const r = await callRoute(stateRoutes, "/api/plans/upcoming");
      const body = r.json as UpcomingPlansDTO;
      assert.equal(body.unavailable, "connect ECONNREFUSED");
      assert.deepEqual(
        body.plans.map((p) => p.serviceTypeId),
        [],
        "stepping onto a plan of a type the operator just turned off saves a real override nothing will read",
      );
    } finally {
      ctl.listServiceTypes = real;
    }
  });

  it("and a cache entry made under a different allowlist is never served", async () => {
    // The allowlist moved WITHOUT going through setAllowedServiceTypes — a
    // restore, or a future writer. The cache key has to carry it too, or the
    // clear above is the only thing standing between the operator and a stale
    // list, and it only covers the one call site that exists today.
    await callRoute(stateRoutes, "/api/plans/upcoming");
    ctl.state.allowedServiceTypeIds = ["st-youth"];

    const r = await callRoute(stateRoutes, "/api/plans/upcoming");
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(body.plans.map((p) => p.planId), ["youth-next"]);
    assert.equal(body.cacheAgeMs, 0);
  });
});

describe("when Planning Center cannot answer", () => {
  it("is a 200 with a reason and an empty list, not a 5xx", async () => {
    ctl.listServiceTypes = async () => {
      throw new Error("Planning Center is not configured");
    };
    const r = await callRoute(stateRoutes, "/api/plans/upcoming");
    assert.equal(r.status, 200, "a 5xx would tell the operator this app broke; the editor still works");
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(body.plans, []);
    assert.equal(body.unavailable, "Planning Center is not configured");
    ctl.listServiceTypes = async () => TYPES;
  });

  it("serves the last good list, aged, when there is one", async () => {
    await callRoute(stateRoutes, "/api/plans/upcoming");
    ctl.upcomingCache = {
      at: NOW - 10 * 60 * 1000,
      days: 60,
      allowed: [],
      plans: [
        {
          serviceTypeId: "st-sun",
          serviceTypeName: "Sunday",
          planId: "sun-now",
          title: "Sunday morning",
          sortDate: new Date(NOW).toISOString(),
          dates: null,
          isCurrent: true,
        },
      ],
    };
    ctl.listServiceTypes = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const r = await callRoute(stateRoutes, "/api/plans/upcoming");
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(body.plans.map((p) => p.planId), ["sun-now"]);
    assert.equal(body.unavailable, "connect ECONNREFUSED");
    assert.ok(body.cacheAgeMs >= 10 * 60 * 1000, "an operator must be able to see how stale this is");
    ctl.listServiceTypes = async () => TYPES;
  });

  it("one unreachable service type does not empty the whole list", async () => {
    byType["st-youth"] = new Error("502 from Planning Center");
    const r = await callRoute(stateRoutes, "/api/plans/upcoming");
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(
      body.plans.map((p) => p.planId),
      ["sun-now", "sun-next"],
      "one type failing is not evidence about the other five",
    );
    assert.equal(body.unavailable, undefined);
  });

  it("every type unreachable IS unavailable", async () => {
    byType["st-sun"] = new Error("502 from Planning Center");
    byType["st-youth"] = new Error("502 from Planning Center");
    const r = await callRoute(stateRoutes, "/api/plans/upcoming");
    const body = r.json as UpcomingPlansDTO;
    assert.deepEqual(body.plans, []);
    assert.equal(body.unavailable, "Sunday: 502 from Planning Center");
  });
});

describe("POST /api/plan-switcher-mode", () => {
  it("sets the mode and returns the new state", async () => {
    const r = await callRoute(viewRoutes, "/api/plan-switcher-mode", {
      method: "POST",
      body: { mode: "within-type" },
    });
    assert.equal((r.json as StageState).planSwitcherMode, "within-type");
  });

  it("refuses a mode it does not know rather than storing it", async () => {
    const r = await callRoute(viewRoutes, "/api/plan-switcher-mode", {
      method: "POST",
      body: { mode: "sideways" },
    });
    assert.equal(r.status, 400);
    assert.equal(stageController.getState().planSwitcherMode, "within-type", "the bad value was not stored");
  });
});
