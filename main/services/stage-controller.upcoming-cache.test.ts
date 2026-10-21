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
  readPlans: (serviceTypeId: string) => Promise<{ plans: unknown[]; recentFailed: boolean }>;
  state: Record<string, unknown>;
  upcomingCache: unknown;
  lastRefreshLine: string;
  plansOutage: { forget: () => void };
};

const NOW = Date.parse("2026-10-06T15:00:00Z");
const PLAN = (id: string) => ({ id, title: `Plan ${id}`, seriesTitle: null, sortDate: "2026-10-11T15:00:00Z", dates: "Oct 11" });

let reads: string[] = [];
let failing = new Set<string>();
/** Types whose upcoming plans read, and whose recent plans did not. */
let recentFailing = new Set<string>();

beforeEach(() => {
  reads = [];
  ctl.lastRefreshLine = "";
  failing = new Set();
  recentFailing = new Set();
  ctl.upcomingCache = null;
  ctl.lastRefreshLine = "";
  ctl.plansOutage.forget();
  ctl.state = { ...ctl.state, allowedServiceTypeIds: [], planId: null };
  ctl.listServiceTypes = async () => [
    { id: "1", name: "Sunday" },
    { id: "2", name: "Wednesday" },
  ];
  ctl.readPlans = async (id) => {
    reads.push(id);
    if (failing.has(id)) throw new Error("Planning Center returned 503");
    return { plans: [PLAN(`p${id}`)], recentFailed: recentFailing.has(id) };
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

  it("names the types it could not read in full, and none when it read them all", async (t) => {
    captureConsole(t, "log", "warn");
    assert.equal("incompleteTypeIds" in (await listAt(t, 0)), false, "a whole list named types it had read");

    failing.add("2");
    ctl.upcomingCache = null;
    const down = await listAt(t, 1000);
    assert.deepEqual(down.incompleteTypeIds, ["2"]);
    // From the cache too: the second reader must not be told the shorter list is the whole one.
    assert.deepEqual((await listAt(t, 2000)).incompleteTypeIds, ["2"], "the cached partial list lost its note");
  });

  it("names a type whose recent plans failed, though its upcoming plans came back", async (t) => {
    // The list keeps those plans, and the type is still partly unread: a plan from the recent half is missing, not gone.
    captureConsole(t, "log", "warn");
    recentFailing.add("1");
    const list = await listAt(t, 0);
    assert.deepEqual(list.plans.map((p) => p.serviceTypeId).sort(), ["1", "2"]);
    assert.deepEqual(list.incompleteTypeIds, ["1"]);
    await listAt(t, UPCOMING_PARTIAL_CACHE_MS - 1);
    assert.equal(reads.length, 2, "the partial list was read again before its short window");
    recentFailing.clear();
    const later = await listAt(t, UPCOMING_PARTIAL_CACHE_MS + 1);
    assert.equal("incompleteTypeIds" in later, false);
  });

  it("says the refreshed list once while it is the same, and again when it changes", async (t) => {
    const lines = captureConsole(t, "log", "warn");
    const said = () => lines.filter((l) => l.includes("[plans] upcoming list refreshed"));
    await listAt(t, 0);
    await listAt(t, UPCOMING_CACHE_MS + 1);
    await listAt(t, 2 * UPCOMING_CACHE_MS + 2);
    assert.equal(reads.length, 6, "the list was reused, so this proves nothing about the line");
    assert.equal(said().length, 1, `an unchanged list said again at every refresh: ${JSON.stringify(said())}`);

    failing.add("2");
    await listAt(t, 3 * UPCOMING_CACHE_MS + 3);
    assert.equal(said().length, 2, "a changed list was not said");
    assert.match(said()[1]!, /1 plans across 2 types/);
  });

  it("still labels a plan from the partial list", async (t) => {
    captureConsole(t, "log", "warn");
    failing.add("2");
    await listAt(t, 0);
    const cached = (stageController as unknown as { cachedUpcoming: (id: string) => { title: string } | null }).cachedUpcoming("p1");
    assert.equal(cached?.title, "Plan p1");
  });
});
