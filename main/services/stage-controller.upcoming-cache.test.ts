// The plan switcher's list is reused for five minutes, so a service type that
// failed to read must not be left out for all of them.
//
// getUpcomingPlanList used to store a list missing a type exactly as it stored a
// whole one: a type that blipped once was absent from the switcher until the five
// minutes ran out. A partial list is now reused for thirty seconds, and a whole one
// still for five minutes. Driven through the real controller with the two reads it
// makes replaced, and the clock moved by hand.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "upcoming-cache-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { stageController } = await import("./stage-controller.js");
const { UPCOMING_CACHE_MS, UPCOMING_PARTIAL_CACHE_MS } = await import("./upcoming-plans.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

after(() => fs.rm(TMP, { recursive: true, force: true }));

const ctl = stageController as unknown as {
  listServiceTypes: () => Promise<{ id: string; name: string }[]>;
  listPlans: (serviceTypeId: string) => Promise<unknown[]>;
  state: Record<string, unknown>;
  upcomingCache: unknown;
  plansOutage: { forget: () => void };
};

const NOW = Date.parse("2026-10-06T15:00:00Z");
const PLAN = (id: string) => ({ id, title: `Plan ${id}`, seriesTitle: null, sortDate: "2026-10-11T15:00:00Z", dates: "Oct 11" });

let reads: string[] = [];
let failing = new Set<string>();

beforeEach(() => {
  reads = [];
  failing = new Set();
  ctl.upcomingCache = null;
  ctl.plansOutage.forget();
  ctl.state = { ...ctl.state, allowedServiceTypeIds: [], planId: null };
  ctl.listServiceTypes = async () => [
    { id: "1", name: "Sunday" },
    { id: "2", name: "Wednesday" },
  ];
  ctl.listPlans = async (id) => {
    reads.push(id);
    if (failing.has(id)) throw new Error("Planning Center returned 503");
    return [PLAN(`p${id}`)];
  };
});

/** The list as of `at` ms after NOW. */
async function listAt(t: { mock: { method: (o: object, n: string, f: () => number) => unknown } }, at: number) {
  t.mock.method(Date, "now", () => NOW + at);
  return stageController.getUpcomingPlanList(60);
}

describe("getUpcomingPlanList caching", () => {
  it("reuses a whole list for the full five minutes", async (t) => {
    captureConsole(t, "log", "warn");
    await listAt(t, 0);
    assert.equal(reads.length, 2);
    await listAt(t, UPCOMING_CACHE_MS - 1);
    assert.equal(reads.length, 2, "a whole list was read again inside its window");
    await listAt(t, UPCOMING_CACHE_MS + 1);
    assert.equal(reads.length, 4);
  });

  it("asks again within thirty seconds when a service type was missing, and gets it back", async (t) => {
    const lines = captureConsole(t, "log", "warn");
    failing.add("2");
    const first = await listAt(t, 0);
    assert.deepEqual(first.plans.map((p) => p.serviceTypeId), ["1"]);
    assert.equal(lines.filter((l) => l.includes("[plans] upcoming list incomplete")).length, 1);

    await listAt(t, UPCOMING_PARTIAL_CACHE_MS - 1);
    assert.equal(reads.length, 2, "a partial list was read again before its short window");

    failing.clear();
    const later = await listAt(t, UPCOMING_PARTIAL_CACHE_MS + 1);
    assert.deepEqual(later.plans.map((p) => p.serviceTypeId).sort(), ["1", "2"], "the blipped type did not come back");
  });

  it("says a type that stays down once per outage, and says when it is back", async (t) => {
    // A partial list is reused for thirty seconds, so a type that is down for ten
    // minutes is read on about twenty refreshes. The line used to come out on each.
    const lines = captureConsole(t, "log", "warn");
    const incomplete = () => lines.filter((l) => l.includes("[plans] upcoming list incomplete"));
    failing.add("2");
    for (let i = 0; i < 4; i++) await listAt(t, i * (UPCOMING_PARTIAL_CACHE_MS + 1));
    assert.equal(reads.filter((id) => id === "2").length, 4, "the list was reused instead of read each time, so this proves nothing");
    assert.equal(incomplete().length, 1, `one outage, one line: ${JSON.stringify(incomplete())}`);
    assert.match(incomplete()[0]!, /Wednesday could not be read — Planning Center returned 503/);

    failing.clear();
    const lastFail = 3 * (UPCOMING_PARTIAL_CACHE_MS + 1);
    await listAt(t, lastFail + UPCOMING_PARTIAL_CACHE_MS + 1);
    const back = () => lines.filter((l) => l.includes("Wednesday can be read again"));
    assert.equal(back().length, 0, "recovery was announced inside the settle window, where a flapping type would repeat it");
    await listAt(t, lastFail + UPCOMING_PARTIAL_CACHE_MS + 1 + UPCOMING_CACHE_MS + 1);
    assert.equal(back().length, 1, `the recovery line: ${JSON.stringify(lines)}`);

    // And the next outage is news again.
    failing.add("2");
    await listAt(t, lastFail + 10 * UPCOMING_CACHE_MS);
    assert.equal(incomplete().length, 2, "a second outage after a recovery must be logged");
  });

  it("says once that the list is unavailable while every type stays down, and when it is back", async (t) => {
    // Nothing unavailable is cached, so every request while Planning Center is
    // down reads it again and lands on the unavailable answer.
    const lines = captureConsole(t, "log", "warn");
    const down = () => lines.filter((l) => l.includes("[plans] upcoming list unavailable"));
    failing.add("1");
    failing.add("2");
    for (let i = 0; i < 4; i++) await listAt(t, i * 1000);
    assert.equal(reads.length, 8, "each request read both types, so this proves the line is deduplicated, not skipped");
    assert.equal(down().length, 1, `one outage, one line: ${JSON.stringify(down())}`);

    failing.clear();
    await listAt(t, 3000 + UPCOMING_CACHE_MS + 1);
    assert.equal(lines.filter((l) => l.includes("[plans] upcoming list available again")).length, 1, JSON.stringify(lines));
  });

  it("still labels a plan from the partial list", async (t) => {
    captureConsole(t, "log", "warn");
    failing.add("2");
    await listAt(t, 0);
    const cached = (stageController as unknown as { cachedUpcoming: (id: string) => { title: string } | null }).cachedUpcoming("p1");
    assert.equal(cached?.title, "Plan p1");
  });
});
