// rebuild-baptism-merge.test.ts — rebuildServiceBaptisms MERGES a service's
// baptism sessions into the store; it never replaces them.
//
// Ruling 57 overturned the original plan text ("REPLACE that serviceKey's
// stored sessions"): replacing a service's whole set would delete every
// stored session the rows cannot reproduce — a session split across a
// mid-session serviceKey roll (its start and finish land in two directories,
// so the replay drops it), one recorded before the raw layer existed, or one
// whose rows were lost. CLAUDE.md: never delete an operator's data to tidy
// something up.
//
// Three scenarios, each proven red in this session (see the report for the
// exact commands and output):
//
//   1. An intact store — real sessions, driven through the real timer so
//      their ids and stamps are exact (Task 16) — is untouched byte for byte.
//      Red against a merge that silently reorders the array on every write
//      instead of leaving an unmatched entry exactly where it was.
//   2. A stored session the rows cannot reproduce (the roll case) survives a
//      rebuild of that service untouched. Red against a REPLACE that drops
//      anything not in the rebuilt set.
//   3. A stored session recorded before Task 16, whose startedAt is 1ms off
//      the row's, is updated in place — not duplicated. Red against
//      id-only matching, which cannot see the two describe the same session.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-merge-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("../baptism-timer-service.js");
const { baptismStore } = await import("../baptism-store.js");
const { serviceTimelineStore } = await import("../service-timeline-store.js");
const { serviceTimelineRecorder } = await import("../service-timeline-recorder.js");
const { rebuildServiceBaptisms } = await import("../history-edit.js");
const { sampleArchive } = await import("./sample-archive.js");
const { serviceDirPath } = await import("./archive-paths.js");
const { baptismSessionId } = await import("../../types/stage.js");
const { freshCtx, openService, sleep, storedSessions } = await import("./baptism-roundtrip-harness.js");

const BAPTISM_JSON = path.join(TMP, "baptism.json");

/** A minimal, valid ServiceTimeline record — just enough for serviceDateOf to
 *  find the archive directory and for the identity fields a NEW session picks
 *  up from it. */
function timeline(serviceKey: string, serviceDate: string, planTitle = "Sunday Gathering") {
  return {
    serviceKey,
    serviceTypeId: "st1",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle,
    seriesTitle: null,
    serviceDate,
    serviceTimeId: serviceKey,
    serviceTimeStartsAt: null,
    startedAt: `${serviceDate}T09:00:00.000Z`,
    endedAt: `${serviceDate}T10:30:00.000Z`,
    items: [],
  } as never;
}

async function readStoreFile(): Promise<string> {
  return fs.readFile(BAPTISM_JSON, "utf8");
}

describe("rebuildServiceBaptisms — an intact store", () => {
  it("changes nothing, byte for byte", async () => {
    const ctx = freshCtx("merge-intact");
    await serviceTimelineStore.upsert(timeline(ctx.serviceKey, ctx.serviceDate));
    openService(ctx);

    // Two real sessions on the same service, so the store holds more than one
    // entry — a merge that silently reorders the array is invisible against a
    // single-session store, where there is only one position to hold.
    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");
    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.finish();
    await storedSessions(ctx, 1);
    await sleep(8);
    baptismTimerService.reset();
    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.finish();
    await storedSessions(ctx, 2);
    await sampleArchive.flush();
    serviceTimelineRecorder.forget(ctx.serviceKey);

    const before = await readStoreFile();
    const outcome = await rebuildServiceBaptisms(ctx.serviceKey);
    const after = await readStoreFile();

    assert.equal(outcome.updated, 2, "both real sessions should be matched and reconciled");
    assert.equal(outcome.added, 0);
    assert.equal(outcome.kept, 0);
    assert.equal(after, before, "an intact store must not be rewritten by its own rebuild, byte for byte");
  });
});

describe("rebuildServiceBaptisms — the roll case", () => {
  it("keeps a stored session the rows cannot reproduce", async () => {
    const KEY = "roll-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));

    // Simulates a session split across a mid-session serviceKey roll: it is
    // stored, but nothing in THIS service's rows reconstructs it.
    const rollSession = {
      id: "bap-roll-9999",
      startedAt: "2026-09-20T09:00:00.000Z",
      finishedAt: "2026-09-20T09:05:00.000Z",
      people: [{ testimonyMs: 60_000, baptizeMs: 240_000 }],
      title: "Sunday Gathering",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession;
    await baptismStore.addSession(rollSession);

    // The rows this rebuild DOES have: one full, unrelated session, hours
    // later, so the merge has something to add and is not a total no-op.
    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "baptism.csv"),
      [
        "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail",
        "2026-09-20T11:00:00.000Z,start,per-person,testimony,1,0,0,,,",
        "2026-09-20T11:05:00.000Z,testimony-end,per-person,testimony,1,0,300000,,,",
        "2026-09-20T11:05:00.000Z,finish,per-person,testimony,1,0,300000,,,",
        "",
      ].join("\n"),
      "utf8",
    );

    const outcome = await rebuildServiceBaptisms(KEY);

    assert.equal(outcome.added, 1, "the new session should be added");
    assert.equal(outcome.updated, 0);
    assert.equal(outcome.kept, 1, "the roll session has no rebuilt counterpart");

    const stillThere = (await baptismStore.listSessions()).find((s) => s.id === rollSession.id);
    assert.deepEqual(stillThere, rollSession, "the roll session must survive the rebuild untouched");
  });
});

describe("rebuildServiceBaptisms — the skew case", () => {
  it("updates a session whose stored startedAt is 1ms off the row's, in place", async () => {
    const KEY = "skew-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));

    // Recorded before Task 16: the store's startedAt (and therefore its id)
    // is 1ms later than what the row itself says.
    const storedStartedAt = "2026-09-20T12:00:00.001Z";
    const rowStartedAt = "2026-09-20T12:00:00.000Z";
    const staleSession = {
      id: baptismSessionId(storedStartedAt),
      startedAt: storedStartedAt,
      finishedAt: "2026-09-20T12:04:00.001Z",
      people: [{ testimonyMs: 1, baptizeMs: 1 }], // deliberately stale, to prove the update lands
      title: "Sunday Gathering",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession;
    await baptismStore.addSession(staleSession);
    assert.notEqual(baptismSessionId(rowStartedAt), staleSession.id, "precondition: the 1ms skew changes the id");

    const dir = serviceDirPath(KEY, DATE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "baptism.csv"),
      [
        "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail",
        `${rowStartedAt},start,per-person,testimony,1,0,0,,,`,
        "2026-09-20T12:02:00.000Z,testimony-end,per-person,baptism,1,0,100000,,,",
        "2026-09-20T12:04:00.000Z,person-complete,per-person,baptism,1,0,140000,,,",
        "2026-09-20T12:04:00.000Z,finish,per-person,baptism,1,0,140000,,,",
        "",
      ].join("\n"),
      "utf8",
    );

    const outcome = await rebuildServiceBaptisms(KEY);

    assert.equal(outcome.updated, 1, "the skewed session should be matched, not added as a duplicate");
    assert.equal(outcome.added, 0);

    const forService = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);
    assert.equal(forService.length, 1, "exactly one session for this service — no duplicate");
    assert.equal(forService[0]!.id, staleSession.id, "the STORED id survives, not the rebuilt one");
    assert.equal(forService[0]!.startedAt, storedStartedAt, "the STORED startedAt survives");
    assert.deepEqual(
      forService[0]!.people,
      [{ testimonyMs: 100_000, baptizeMs: 140_000 }],
      "people come from the rebuild, which is what the rows know and the store did not",
    );
    assert.equal(forService[0]!.finishedAt, "2026-09-20T12:04:00.000Z", "finishedAt comes from the rebuild too");
  });
});
