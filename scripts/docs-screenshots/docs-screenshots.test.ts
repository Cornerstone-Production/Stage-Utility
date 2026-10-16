// The screenshot data, run through the app's own readers.
//
// The images are only as good as the invented data behind them, and that data is
// only useful while the app still reads it. Two things can drift without anything
// failing: the Planning Center fake can stop matching what pco-service.ts asks
// for, and the history files can stop matching what the recorded-history stores
// load. Either way the capture step would still "succeed", on a Home with no plan
// and a History with no services. So both are checked here by running the REAL
// code over them, not by reading their source:
//
//   - the Planning Center fake answers pcoService, the app's real client, in both
//     modes, and what comes back has the shape the screenshots rely on
//   - the seeded history files are loaded by the real keyed stores, and every
//     record is found, with its key matching the plan the fake reports
//
// Each assertion was proved red by a scratch edit of the fake or the seed that
// reintroduces the drift it guards (named beside it).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, before, describe, it } from "node:test";

// @ts-expect-error plain ESM without declarations
import { handlePco } from "./fakes/pco.mjs";
// @ts-expect-error plain ESM without declarations
import { seedHistoryFiles } from "./seed/history.mjs";
// @ts-expect-error plain ESM without declarations
import { LIVE_PLAN_ID, SERVICE_TYPES, WEEKEND_ROSTER, planFor, plansFor } from "./world.mjs";

// 18 Oct 2026 is a Sunday; the anchor is the Thursday before it.
const NOW = new Date("2026-10-15T18:00:00Z");

const realFetch = globalThis.fetch;
let live = false;

function installFake(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "api.planningcenteronline.com", "the app asked something other than Planning Center");
    const answer = handlePco(url.pathname.replace("/services/v2", ""), url.searchParams, { now: NOW, live });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("the Planning Center fake, read by the real client", () => {
  let pco: typeof import("../../main/services/pco-service.js").pcoService;
  before(async () => {
    ({ pcoService: pco } = await import("../../main/services/pco-service.js"));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    live = false;
    pco.clearCache();
  });

  it("lists the three service types by name", async () => {
    installFake();
    const types = await pco.listServiceTypes("app", "secret");
    assert.deepEqual(
      types.map((t) => t.name),
      ["Weekend", "The Gathering", "Youth Night"],
    );
  });

  it("lists the upcoming Weekend plan with its title and date", async () => {
    installFake();
    const plans = await pco.listUpcomingPlans("app", "secret", SERVICE_TYPES[0].id);
    const sunday = planFor("weekend", 0, NOW);
    assert.equal(plans[0].id, sunday.id);
    assert.equal(plans[0].title, sunday.title);
    assert.equal(plans[0].dates, "Oct 18, 2026");
  });

  it("gives the rundown its songs, headers, notes and arrangement details", async () => {
    installFake();
    const sunday = planFor("weekend", 0, NOW);
    const items = await pco.listPlanItems("app", "secret", SERVICE_TYPES[0].id, sunday.id);
    assert.equal(items.filter((i) => i.itemType === "header").length, 4);
    const song = items.find((i) => i.title === "Open Up the Sky");
    assert.equal(song?.songKey, "G");
    assert.equal(song?.bpm, 78);
    assert.equal(song?.notesByCategory.Audio, "Reverb on lead vocal");
  });

  it("gives the roster its twelve people with positions and notes", async () => {
    installFake();
    const sunday = planFor("weekend", 0, NOW);
    const members = await pco.listTeamMembers("app", "secret", SERVICE_TYPES[0].id, sunday.id);
    assert.equal(members.length, WEEKEND_ROSTER.length);
    const lead = members.find((m) => m.name === "Alex Rivera");
    assert.equal(lead?.teamPositionName, "Worship Leader");
    assert.equal(lead?.teamName, "Vocals");
    assert.equal(lead?.notes, "1");
  });

  it("reports no item on air in the week phase, and Hold Fast on air when live", async () => {
    installFake();
    const sunday = planFor("weekend", 0, NOW);
    const quiet = await pco.getLive("app", "secret", SERVICE_TYPES[0].id, sunday.id);
    assert.equal(quiet.mode, "preservice");

    live = true;
    pco.clearCache();
    const types = SERVICE_TYPES[0].id;
    const upcoming = await pco.listUpcomingPlans("app", "secret", types);
    assert.ok(upcoming.some((p) => p.id === LIVE_PLAN_ID), "the live plan is not in the upcoming list");
    const on = await pco.getLive("app", "secret", types, LIVE_PLAN_ID);
    assert.equal(on.mode, "item");
    assert.equal(on.label, "Hold Fast");
    assert.equal(on.nextItemTitle, "Welcome and Announcements");
  });
});

describe("the seeded history, read by the real stores", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-shots-history-"));

  it("loads every record, and each one names a plan the fake reports", async () => {
    process.env.STAGE_UTILITY_DATA = dir;
    seedHistoryFiles(dir, NOW);
    const { attendanceStore } = await import("../../main/services/attendance-store.js");
    const { serviceTimelineStore } = await import("../../main/services/service-timeline-store.js");
    const { splHistoryStore } = await import("../../main/services/spl-history-store.js");

    const attendance = await attendanceStore.list();
    const timeline = await serviceTimelineStore.list();
    const spl = await splHistoryStore.list();

    // Weekend 13 weeks x 2 services, The Gathering 9, Youth Night 7.
    const expected = [
      ...plansFor("weekend", NOW, 13, 0).filter((p: { week: number }) => p.week < 0).flatMap((p: { typeId: string; id: string; times: { id: string }[] }) => p.times.map((t) => `${p.typeId}:${p.id}:${t.id}`)),
    ];
    assert.equal(attendance.length, 26 + 9 + 7);
    assert.equal(timeline.length, attendance.length);
    assert.equal(spl.length, attendance.length);
    const weekendKeys = attendance.filter((r) => r.serviceTypeId === SERVICE_TYPES[0].id).map((r) => r.serviceKey).sort();
    assert.deepEqual(weekendKeys, [...expected].sort());
    for (const record of attendance) {
      assert.ok(record.samples.length > 10, `${record.serviceKey} has no curve`);
      assert.ok(record.peakAttendance > 0);
    }
    for (const record of timeline) assert.ok(record.items.length >= 8, `${record.serviceKey} has no rundown`);
  });
});
