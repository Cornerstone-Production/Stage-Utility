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
    // Deliberately different from the stored session's own labels below (M2):
    // a matched session keeps ITS OWN title/serviceTypeId/planId, never the
    // timeline record's — the rows cannot carry those labels at all, and only
    // an UNMATCHED (added) session should ever pick them up from the timeline.
    await serviceTimelineStore.upsert(timeline(KEY, DATE, "Timeline Title"));

    // Recorded before Task 16: the ROW's own stamp is a separate, later read
    // of the clock than the store's (see rebuild-baptism.ts's header) — so
    // the store's startedAt/finishedAt (and therefore its id) are both
    // EARLIER than what the row itself says, by about 1ms. This is clock
    // skew noise, not a real correction, and must not be read as "the store
    // is newer" (C1) — the rebuild still applies.
    const storedStartedAt = "2026-09-20T12:00:00.001Z";
    const rowStartedAt = "2026-09-20T12:00:00.000Z";
    const staleSession = {
      id: baptismSessionId(storedStartedAt),
      startedAt: storedStartedAt,
      finishedAt: "2026-09-20T12:03:59.999Z",
      people: [{ testimonyMs: 1, baptizeMs: 1 }], // deliberately stale, to prove the update lands
      title: "Stored Title",
      serviceTypeId: "stored-type",
      planId: "stored-plan",
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
    assert.equal(forService[0]!.title, "Stored Title", "the STORED title survives — the rows carry no label at all");
    assert.equal(forService[0]!.serviceTypeId, "stored-type", "the STORED serviceTypeId survives");
    assert.equal(forService[0]!.planId, "stored-plan", "the STORED planId survives");
  });
});

// ── Two rebuilt sessions close enough together to contend for one match ────
//
// Both scenarios below share one CSV shape: A is a per-person Start then
// Finish mid-testimony (finish() pushes the running testimony as a person, so
// it IS logged) 1 second later, then Reset, then B starts 1.5 seconds after A
// did and runs a full testimony + baptism. Transcribed from the reviewer's
// P1/P2 probes (zz-review-probe.test.ts) into real, committed tests.
const HEADER_ROW = "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail";

function twoCloseSessionsCsv(t: string, taEnd: string, tb: string, tbEnd: string): string {
  // B's own testimony-end, 118.5s (matching its own segmentMs) after B's
  // start — computed relative to `tb`, not a hardcoded absolute timestamp:
  // every test using this fixture picks its own well-separated hour (see the
  // P1 test's comment on why), and a fixed clock string here would sort out
  // of order the moment `tb` moved to a different hour, corrupting the whole
  // replay ("skipped N row(s) belonging to no started session").
  const tbTestimonyEnd = new Date(Date.parse(tb) + 118_500).toISOString();
  return [
    HEADER_ROW,
    `${t},start,per-person,testimony,1,0,0,,,`,
    `${taEnd},testimony-end,per-person,testimony,1,0,1000,,,`,
    `${taEnd},finish,per-person,testimony,1,0,1000,,,`,
    `${taEnd},reset,per-person,idle,0,0,0,,,`,
    `${tb},start,per-person,testimony,1,0,0,,,`,
    `${tbTestimonyEnd},testimony-end,per-person,baptism,1,0,118500,,,`,
    `${tbEnd},person-complete,per-person,baptism,1,0,120000,,,`,
    `${tbEnd},finish,per-person,baptism,1,0,120000,,,`,
    "",
  ].join("\n");
}

async function writeBaptismCsv(key: string, date: string, csv: string): Promise<void> {
  const dir = serviceDirPath(key, date);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "baptism.csv"), csv, "utf8");
}

describe("rebuildServiceBaptisms — id matching decided for the whole batch before the 2s fallback runs (P1)", () => {
  it("restores a deleted session and leaves its sibling's stored labels alone", async () => {
    const KEY = "p1-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour: baptismStore is a singleton shared by
    // every test in this file, and matching is deliberately GLOBAL (ruling
    // 2) — two tests using overlapping timestamps would match each other's
    // leftover sessions instead of their own fixtures.
    const t = "2026-09-20T18:00:00.000Z";
    const taEnd = "2026-09-20T18:00:01.000Z";
    const tb = "2026-09-20T18:00:01.500Z"; // 1.5s after A's start
    const tbEnd = "2026-09-20T18:04:00.000Z";
    await writeBaptismCsv(KEY, DATE, twoCloseSessionsCsv(t, taEnd, tb, tbEnd));

    // B as the live timer stored it: exact id (post-Task 16), its OWN title —
    // A was deleted from Past sessions, and Ruling 59/I3 says a rebuild may
    // bring it back.
    await baptismStore.addSession({
      id: baptismSessionId(tb),
      startedAt: tb,
      finishedAt: tbEnd,
      people: [{ testimonyMs: 118_500, baptizeMs: 120_000 }],
      title: "Stored Title",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const stored = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);

    assert.equal(outcome.added, 1, "A should be added back");
    assert.equal(outcome.updated, 1, "B should be matched by its exact id, not disturbed by A's fallback");
    assert.ok(stored.some((s) => s.id === baptismSessionId(t)), "deleted session A was not restored");
    assert.equal(
      stored.find((s) => s.id === baptismSessionId(tb))?.title,
      "Stored Title",
      "B's stored title must not be overwritten by A's fallback match stealing B's own id-matched slot",
    );
  });
});

describe("rebuildServiceBaptisms — the nearest candidate wins, not the first found (P2)", () => {
  it("updates each of two close, pre-Task-16-skewed sessions with its OWN rebuilt people, never the other's", async () => {
    const KEY = "p2-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see P1's own comment on why.
    const t = "2026-09-20T19:00:00.000Z";
    const taEnd = "2026-09-20T19:00:01.000Z";
    const tb = "2026-09-20T19:00:01.500Z";
    const tbEnd = "2026-09-20T19:04:00.000Z";
    await writeBaptismCsv(KEY, DATE, twoCloseSessionsCsv(t, taEnd, tb, tbEnd));

    const sa = "2026-09-20T19:00:00.001Z"; // stored 1ms after its own row, as before Task 16
    await baptismStore.addSession({
      id: baptismSessionId(sa),
      startedAt: sa,
      finishedAt: "2026-09-20T19:00:00.999Z", // earlier than the row's own 19:00:01.000 finish
      people: [{ testimonyMs: 1, baptizeMs: 0 }],
      title: "Stored Title",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);
    await baptismStore.addSession({
      id: baptismSessionId(tb),
      startedAt: tb,
      finishedAt: tbEnd,
      people: [{ testimonyMs: 118_500, baptizeMs: 120_000 }],
      title: "Stored Title",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const stored = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);
    const a = stored.find((s) => s.id === baptismSessionId(sa))!;
    const b = stored.find((s) => s.id === baptismSessionId(tb))!;

    assert.equal(outcome.updated, 2, "both A and B should be matched and reconciled, not swapped or duplicated");
    assert.deepEqual(a.people, [{ testimonyMs: 1000, baptizeMs: 0 }], "A got B's people instead of its own");
    assert.deepEqual(b.people, [{ testimonyMs: 118_500, baptizeMs: 120_000 }], "B got A's people instead of its own");
    assert.ok(Date.parse(b.finishedAt) > Date.parse(b.startedAt), "B now finishes before it starts — the two were swapped");
  });
});

describe("rebuildServiceBaptisms — the 2-second ceiling", () => {
  it("does not match a stored session 3 seconds away — only within 2s", async () => {
    const KEY = "ceiling-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the P1 test's own comment on why.
    const rowStart = "2026-09-20T20:00:03.000Z";
    await writeBaptismCsv(
      KEY,
      DATE,
      [
        HEADER_ROW,
        `${rowStart},start,per-person,testimony,1,0,0,,,`,
        "2026-09-20T20:00:05.000Z,testimony-end,per-person,testimony,1,0,2000,,,",
        "2026-09-20T20:00:05.000Z,finish,per-person,testimony,1,0,2000,,,",
        "",
      ].join("\n"),
    );
    // Exactly 3000ms before the row's own start — outside BAPTISM_SKEW_MS (2000ms).
    const farStoredStart = "2026-09-20T20:00:00.000Z";
    await baptismStore.addSession({
      id: baptismSessionId(farStoredStart),
      startedAt: farStoredStart,
      finishedAt: "2026-09-20T20:00:02.000Z",
      people: [{ testimonyMs: 1, baptizeMs: 0 }],
      title: "Untouched",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const stored = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);

    assert.equal(outcome.added, 1, "3 seconds away must not match — the row's own session is added, not merged");
    assert.equal(outcome.kept, 1, "the far session has no rebuilt counterpart and is left alone");
    assert.equal(stored.length, 2, "two distinct sessions, not one merged pair");
    assert.equal(stored.find((s) => s.id === baptismSessionId(farStoredStart))?.title, "Untouched");
  });
});

describe("rebuildServiceBaptisms — matching across services", () => {
  it("matches a stored session under a DIFFERENT serviceKey by id, and keeps its original serviceKey", async () => {
    const KEY = "cross-svc";
    const OTHER_KEY = "some-other-service";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the P1 test's own comment on why.
    const rowStart = "2026-09-20T21:00:00.000Z";
    await writeBaptismCsv(
      KEY,
      DATE,
      [
        HEADER_ROW,
        `${rowStart},start,per-person,testimony,1,0,0,,,`,
        "2026-09-20T21:00:05.000Z,testimony-end,per-person,testimony,1,0,5000,,,",
        "2026-09-20T21:00:05.000Z,finish,per-person,testimony,1,0,5000,,,",
        "",
      ].join("\n"),
    );
    // Same id the rebuild will derive, but stored under a DIFFERENT service —
    // as ruling 2 requires, matched against every stored session so a
    // rebuild can never add a second copy of one the store already has.
    await baptismStore.addSession({
      id: baptismSessionId(rowStart),
      startedAt: rowStart,
      finishedAt: "2026-09-20T21:00:05.000Z",
      people: [{ testimonyMs: 1, baptizeMs: 0 }],
      title: "Other Service Title",
      serviceTypeId: "other-type",
      planId: "other-plan",
      serviceKey: OTHER_KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const all = await baptismStore.listSessions();

    assert.equal(outcome.updated, 1, "the cross-service id match should be recognised, not skipped");
    assert.equal(outcome.added, 0, "matched — must not ALSO be added as a duplicate under KEY");
    assert.equal(all.filter((s) => s.id === baptismSessionId(rowStart)).length, 1, "no duplicate of this id anywhere in the store");
    assert.equal(
      all.find((s) => s.id === baptismSessionId(rowStart))?.serviceKey,
      OTHER_KEY,
      "the matched session keeps ITS OWN serviceKey — a rebuild of KEY must not re-key it",
    );
  });
});

describe("rebuildServiceBaptisms — the MAX_SESSIONS cap", () => {
  it("stores what it reports as added when the added session is newer than everything else", async () => {
    const KEY = "cap-svc";
    const DATE = "2026-09-21";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // 2000 much-older sessions filling the store to capacity.
    const filler = Array.from({ length: 2000 }, (_, i) => {
      const at = new Date(Date.parse("2020-01-01T00:00:00.000Z") + i * 86_400_000).toISOString();
      return {
        id: baptismSessionId(at), startedAt: at, finishedAt: at,
        people: [{ testimonyMs: 1, baptizeMs: 1 }], title: null, serviceTypeId: null, planId: null,
        serviceKey: `old-${i}`,
      };
    });
    await baptismStore.addSessions(filler as never);
    assert.equal((await baptismStore.listSessions()).length, 2000, "precondition: the store is at the cap");

    await writeBaptismCsv(KEY, DATE, [
      HEADER_ROW,
      "2026-09-21T11:00:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-21T11:05:00.000Z,testimony-end,per-person,testimony,1,0,300000,,,",
      "2026-09-21T11:05:00.000Z,finish,per-person,testimony,1,0,300000,,,",
      "",
    ].join("\n"));

    const outcome = await rebuildServiceBaptisms(KEY);
    const all = await baptismStore.listSessions();

    assert.equal(outcome.added, 1, "the new 2026 session is newer than every 2020 filler session and must survive the cap");
    assert.ok(all.some((s) => s.serviceKey === KEY), "reported added, but the session is not in the store");
    assert.equal(all.length, 2000, "the cap still holds — the oldest filler session fell off instead");
  });
});

// ── Ruling 59 / C1: the store can know more than the rows ───────────────────
describe("rebuildServiceBaptisms — a correction made after the service closed", () => {
  it("Finish, the service closes, Undo and a longer re-Finish: the rebuild must not revert it", async () => {
    const ctx = freshCtx("c1-newer");
    await serviceTimelineStore.upsert(timeline(ctx.serviceKey, ctx.serviceDate));
    openService(ctx);

    baptismTimerService.reset();
    baptismTimerService.setMode("per-person");
    baptismTimerService.start();
    await sleep(8);
    baptismTimerService.baptized(); // testimony -> baptism
    await sleep(8);
    const firstFinish = baptismTimerService.finish(); // logs a short baptism, archived — a service is open
    await storedSessions(ctx, 1);
    await sampleArchive.flush();
    assert.ok(firstFinish.people[0]!.baptizeMs > 0, "sanity: the first finish actually baptized someone");

    // The service closes: currentServiceKey() reads endedAt, and emitRaw's
    // own gate is exactly that — see service-key.ts and baptism-timer-service.ts.
    const held = serviceTimelineRecorder as unknown as { current: { endedAt: string | null } | null };
    held.current!.endedAt = new Date().toISOString();

    baptismTimerService.undo(); // reopens the finished session — no service open, nothing archived
    await sleep(40); // a much longer baptism than the first, undone attempt
    const secondFinish = baptismTimerService.finish(); // re-finalizes the SAME session, still not archived
    await storedSessions(ctx, 1);
    await sampleArchive.flush();
    assert.ok(
      secondFinish.people[0]!.baptizeMs > firstFinish.people[0]!.baptizeMs,
      "sanity: the second, real attempt is genuinely longer than the first",
    );

    const before = (await baptismStore.listSessions()).find((s) => s.serviceKey === ctx.serviceKey)!;
    assert.equal(before.finishedAt, secondFinish.finishedAt, "precondition: the store holds the LONGER, corrected session");

    const outcome = await rebuildServiceBaptisms(ctx.serviceKey);
    const after = (await baptismStore.listSessions()).find((s) => s.serviceKey === ctx.serviceKey)!;

    assert.equal(outcome.newer, 1, "the store's own correction is newer than what the (incomplete) rows can show");
    assert.equal(outcome.updated, 0, "the older, row-only version must not be applied over it");
    assert.equal(after.finishedAt, secondFinish.finishedAt, "the correction was reverted to the first, shorter Finish");
    assert.deepEqual(after.people, secondFinish.people, "the corrected baptizeMs was reverted");
  });
});
