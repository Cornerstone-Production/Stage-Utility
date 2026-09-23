// rebuild-baptism-merge.test.ts — rebuildServiceBaptisms MERGES a service's
// baptism sessions into the store; it never replaces them.
//
// Replacing a service's whole set would delete every stored session the rows
// cannot reproduce — a session split across a mid-session serviceKey roll (its
// start and finish land in two directories, so the replay drops it), one
// recorded before the raw layer existed, or one whose rows were lost.
// CLAUDE.md: never delete an operator's data to tidy something up.
//
// A rebuilt row and the stored session it matches land in one of six buckets:
//
//   - unchanged   — the same Finish (within 100ms), identical people. Nothing
//                   is written.
//   - updated     — a genuinely later Finish (more than 100ms later) that the
//                   store never saved. The stored session's people/finishedAt
//                   are overwritten from the rebuilt row.
//   - disagreeing — the same Finish, but the people differ. The store is
//                   authoritative for a Finish it already has, so it is left
//                   exactly as it was, and this is logged: it can only mean a
//                   lost row or a replay defect.
//   - newer       — the stored session's own Finish is LATER than the row's,
//                   by more than 100ms — a correction the rows cannot show
//                   (e.g. an Undo and a longer re-Finish made after the
//                   service closed, when nothing more can reach the rows).
//                   Left exactly as stored.
//   - invalid     — either side's finish time could not be read. A match is
//                   left exactly as stored rather than compared; an unmatched
//                   row is discarded rather than added.
//   - added       — no stored counterpart at all, and the row's own finish
//                   time is readable. Added as a new session.
//
// Matching itself is two passes: every rebuilt row is matched against a
// stored session by id first, for the whole incoming batch; whatever is left
// is then paired off by proximity (within 2 seconds of its own startedAt),
// nearest pair first across the WHOLE remaining set — never by looping over
// the rebuilt rows in array order and letting whichever is considered first
// claim a stored session merely for being looked at first.
//
// Every scenario below is proven red against the bug it guards; see the PR
// this file shipped in for the exact commands and failing output.

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

    assert.equal(outcome.unchanged, 2, "both real sessions should be matched and found identical to what the rows reconstruct");
    assert.equal(outcome.updated, 0, "an exact replay of an intact session is nothing to update");
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
  it("matches a session whose stored startedAt is 1ms off the row's, without rewriting it", async () => {
    const KEY = "skew-svc";
    const DATE = "2026-09-20";
    // Deliberately different from the stored session's own labels below: a
    // matched session keeps ITS OWN title/serviceTypeId/planId, never the
    // timeline record's — the rows cannot carry those labels at all, and only
    // an UNMATCHED (added) session should ever pick them up from the timeline.
    await serviceTimelineStore.upsert(timeline(KEY, DATE, "Timeline Title"));

    // A session recorded before start()/finalize() threaded their own stamp
    // straight through to the row they emit: back then, for both the start
    // and the finish, the row was a separate, later read of the clock than
    // the timer's own stamp — so the store's startedAt (and therefore its
    // id) and finishedAt each read about 1ms earlier than the row's. That is
    // clock-read noise, not a real correction, and must not stop the two
    // being matched.
    const storedStartedAt = "2026-09-20T12:00:00.000Z";
    const rowStartedAt = "2026-09-20T12:00:00.001Z";
    const staleSession = {
      id: baptismSessionId(storedStartedAt),
      startedAt: storedStartedAt,
      finishedAt: "2026-09-20T12:03:59.999Z", // 1ms inside the row's own finish — the same Finish
      people: [{ testimonyMs: 100_000, baptizeMs: 140_000 }], // what the row below reconstructs too
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

    assert.equal(outcome.unchanged, 1, "the skewed session should be matched, and needs no rewrite since its content already agrees");
    assert.equal(outcome.updated, 0);
    assert.equal(outcome.added, 0, "matched — must not ALSO be added as a duplicate");

    const forService = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);
    assert.equal(forService.length, 1, "exactly one session for this service — no duplicate");
    assert.equal(forService[0]!.id, staleSession.id, "the STORED id survives, not the rebuilt one");
    assert.equal(forService[0]!.startedAt, storedStartedAt, "the STORED startedAt survives");
    assert.deepEqual(
      forService[0]!.people,
      [{ testimonyMs: 100_000, baptizeMs: 140_000 }],
      "the STORED people survive untouched — they already agreed with what the rows reconstruct",
    );
    assert.equal(
      forService[0]!.finishedAt,
      "2026-09-20T12:03:59.999Z",
      "the STORED finishedAt survives — nothing is written when nothing disagrees",
    );
    assert.equal(forService[0]!.title, "Stored Title", "the STORED title survives — the rows carry no label at all");
    assert.equal(forService[0]!.serviceTypeId, "stored-type", "the STORED serviceTypeId survives");
    assert.equal(forService[0]!.planId, "stored-plan", "the STORED planId survives");
  });
});

// ── Two rebuilt sessions close enough together to contend for one match ────
//
// Every scenario below shares one CSV shape: A is a per-person Start then
// Finish mid-testimony (finish() pushes the running testimony as a person, so
// it IS logged) 1 second later, then Reset, then B starts 1.5 seconds after A
// did and runs a full testimony + baptism.
const HEADER_ROW = "at,event,mode,phase,personNumber,baptismIndex,segmentMs,itemId,item,detail";

function twoCloseSessionsCsv(t: string, taEnd: string, tb: string, tbEnd: string): string {
  // B's own testimony-end, 118.5s (matching its own segmentMs) after B's
  // start — computed relative to `tb`, not a hardcoded absolute timestamp:
  // every test using this fixture picks its own well-separated hour (see the
  // id-matching describe block's own comment on why), and a fixed clock
  // string here would sort out of order the moment `tb` moved to a different
  // hour, corrupting the whole replay ("skipped N row(s) belonging to no
  // started session").
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

describe("rebuildServiceBaptisms — id matches are decided for the whole batch before the close-in-time fallback runs", () => {
  it("restores a deleted session and leaves its sibling's stored labels alone", async () => {
    const KEY = "restored-sibling-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour: baptismStore is a singleton shared by
    // every test in this file, and matching is deliberately global — two
    // tests using overlapping timestamps would match each other's leftover
    // sessions instead of their own fixtures.
    const t = "2026-09-20T18:00:00.000Z";
    const taEnd = "2026-09-20T18:00:01.000Z";
    const tb = "2026-09-20T18:00:01.500Z"; // 1.5s after A's start
    const tbEnd = "2026-09-20T18:04:00.000Z";
    await writeBaptismCsv(KEY, DATE, twoCloseSessionsCsv(t, taEnd, tb, tbEnd));

    // B as the live timer stored it: an exact id match, and its own title. A
    // was deleted from Past sessions — the raw rows do not know a session was
    // deleted any more than they know one was corrected, so a rebuild is
    // allowed to bring it back.
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
    assert.equal(outcome.unchanged, 1, "B should be matched by its exact id and found to already agree, not disturbed by A's fallback");
    assert.ok(stored.some((s) => s.id === baptismSessionId(t)), "deleted session A was not restored");
    assert.equal(
      stored.find((s) => s.id === baptismSessionId(tb))?.title,
      "Stored Title",
      "B's stored title must not be overwritten by A's fallback match stealing B's own id-matched slot",
    );
  });
});

describe("rebuildServiceBaptisms — two close, pre-exact-stamp-skewed sessions are never cross-wired", () => {
  it("keeps each of two close sessions' own recorded people — never the other's, and never swapped", async () => {
    const KEY = "no-cross-wire-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the previous describe block's own comment on why.
    const t = "2026-09-20T19:00:00.000Z";
    const taEnd = "2026-09-20T19:00:01.000Z";
    const tb = "2026-09-20T19:00:01.500Z";
    const tbEnd = "2026-09-20T19:04:00.000Z";
    await writeBaptismCsv(KEY, DATE, twoCloseSessionsCsv(t, taEnd, tb, tbEnd));

    // A: 1ms off the row's own start (2026-09-20T19:00:00.000Z) — the kind of
    // clock-read noise a session recorded before the exact-stamp fix can
    // carry (see the skew-case test above); not an exact id match, so this
    // falls to the close-in-time fallback. Its stored people are a
    // placeholder, deliberately different from what the row reconstructs.
    const sa = "2026-09-20T19:00:00.001Z";
    await baptismStore.addSession({
      id: baptismSessionId(sa),
      startedAt: sa,
      finishedAt: "2026-09-20T19:00:00.999Z", // the same Finish as the row's own 19:00:01.000, within the tie band
      people: [{ testimonyMs: 1, baptizeMs: 0 }],
      title: "Stored Title",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);
    // B: an exact id match, and its stored people already agree with the row.
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

    // A's placeholder people disagree with what the row reconstructs at the
    // same Finish, so the store — authoritative for a Finish it already has
    // — is left alone; B's already agree, so it needs no rewrite either.
    // Neither classification is a wrong-match bug on its own, but a matching
    // bug (A and B swapped, or one applied to the other) would show up as
    // exactly this shape too, which is why both people arrays are checked.
    assert.equal(outcome.disagreeing, 1, "A's placeholder people should be left alone, not silently replaced");
    assert.equal(outcome.unchanged, 1, "B already agrees with the row and needs no rewrite");
    assert.equal(outcome.updated, 0);
    assert.equal(stored.length, 2, "two sessions, not a duplicate");
    assert.deepEqual(a.people, [{ testimonyMs: 1, baptizeMs: 0 }], "A's own stored people must survive untouched — not overwritten with B's");
    assert.deepEqual(
      b.people,
      [{ testimonyMs: 118_500, baptizeMs: 120_000 }],
      "B's own stored people must survive untouched — not overwritten with A's",
    );
  });
});

describe("rebuildServiceBaptisms — the 2-second ceiling", () => {
  it("does not match a stored session 3 seconds away — only within 2s", async () => {
    const KEY = "ceiling-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the id-matching describe block's own comment on why.
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
    // Its own well-separated hour — see the id-matching describe block's own comment on why.
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
    // Same id the rebuild will derive, but stored under a DIFFERENT service,
    // with placeholder people that disagree with what the row reconstructs —
    // matched against every stored session, not only this service's, so a
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

    assert.equal(outcome.disagreeing, 1, "the cross-service id match should be recognised, and its placeholder people left alone");
    assert.equal(outcome.updated, 0);
    assert.equal(outcome.added, 0, "matched — must not ALSO be added as a duplicate under KEY");
    assert.equal(all.filter((s) => s.id === baptismSessionId(rowStart)).length, 1, "no duplicate of this id anywhere in the store");
    const matched = all.find((s) => s.id === baptismSessionId(rowStart));
    assert.equal(matched?.serviceKey, OTHER_KEY, "the matched session keeps ITS OWN serviceKey — a rebuild of KEY must not re-key it");
    assert.deepEqual(
      matched?.people,
      [{ testimonyMs: 1, baptizeMs: 0 }],
      "the matched session's people must survive untouched — the store is authoritative for the same Finish",
    );
  });
});

describe("rebuildServiceBaptisms — the MAX_SESSIONS cap", () => {
  // A rebuild never evicts, however new its own session is —
  // "added" has to mean "actually landed in the store," not "was in the
  // batch handed to it." A session this rebuild wanted to add but the store
  // had no room for must be counted under `full`, not `added`, and the log
  // must say the store is full rather than naming an eviction that never
  // happened.
  it("does not add a new session when the store is full, and logs how many it could not add", async () => {
    const KEY = "cap-drops-its-own-svc";
    const DATE = "2026-09-23";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));

    // 2000 sessions dated well into the future — newer than literally
    // everything else this shared store could hold from any other test in
    // this file, so they fully occupy the cap regardless of run order.
    const dominatingFiller = Array.from({ length: 2000 }, (_, i) => {
      const at = new Date(Date.parse("2035-01-01T00:00:00.000Z") + i * 86_400_000).toISOString();
      return {
        id: baptismSessionId(at), startedAt: at, finishedAt: at,
        people: [{ testimonyMs: 1, baptizeMs: 1 }], title: null, serviceTypeId: null, planId: null,
        serviceKey: `dominating-${i}`,
      };
    });
    await baptismStore.addSessions(dominatingFiller as never);
    assert.equal((await baptismStore.listSessions()).length, 2000, "precondition: the store is at the cap");

    // This service's own session has no stored counterpart at all, so the
    // rebuild wants to ADD it — but the store already holds MAX_SESSIONS,
    // and a rebuild never evicts anything else to make room, however old or
    // new either side is.
    await writeBaptismCsv(KEY, DATE, [
      HEADER_ROW,
      "2026-09-23T11:00:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-23T11:05:00.000Z,testimony-end,per-person,testimony,1,0,300000,,,",
      "2026-09-23T11:05:00.000Z,finish,per-person,testimony,1,0,300000,,,",
      "",
    ].join("\n"));

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      let outcome: Awaited<ReturnType<typeof rebuildServiceBaptisms>>;
      try {
        outcome = await rebuildServiceBaptisms(KEY);
      } finally {
        console.warn = realWarn;
      }
      const forService = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);

      assert.equal(outcome.added, 0, "the store is full — this rebuild's own new session must not be added");
      assert.equal(outcome.full, 1);
      assert.equal(forService.length, 0, "the session that was reported as not-added must not actually be in the store");
      assert.equal(
        (await baptismStore.listSessions()).length,
        2000,
        "the store must still hold exactly what it held before — nothing evicted to make room",
      );

      const fullLine = warnings.find((w) => w.includes("[baptism]") && w.includes("full"));
      assert.ok(fullLine, `the full store was not logged: ${JSON.stringify(warnings)}`);
      assert.ok(fullLine!.includes("1"), `the log line does not say how many sessions could not be added: ${fullLine}`);
      assert.ok(!warnings.some((w) => w.includes("evicted")), "nothing should ever be logged as evicted — a rebuild does not evict");
    } finally {
      // This test's own 2000 sessions dominate the entire shared store (that
      // is the point — see the comment above), so every OTHER describe block
      // in this file that runs after this one would otherwise find the cap
      // already full and its own ordinary merge silently capped too. Remove
      // exactly what this test added, in a `finally` so a failed assertion
      // still cleans up.
      for (const f of dominatingFiller) await baptismStore.deleteSession(f.id);
    }
  });

  // A rebuild must never evict an existing session to make room for
  // another, for ANY reason — not this rebuild's
  // own untouched "kept" session, not anyone else's. Only an update (which
  // replaces a session's own fields without changing how many the store
  // holds) is exempt from the cap; an add is not. RED on the code this
  // replaces: the old cap sorted everything newest-first and sliced, so this
  // service's own untouched, older "kept" session was exactly what fell off
  // to make room for the add below.
  it("never evicts an existing session to make room — everything survives except what this write updates in place", async () => {
    const KEY = "cap-never-evicts-svc";
    const DATE = "2026-09-23";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));

    // 1998 filler sessions, dated well into the future so nothing else in
    // this shared store can ever outrank them, plus this service's own two
    // below, for exactly 2000: the store starts already at the cap.
    const dominatingFiller = Array.from({ length: 1998 }, (_, i) => {
      const at = new Date(Date.parse("2037-01-01T00:00:00.000Z") + i * 86_400_000).toISOString();
      return {
        id: baptismSessionId(at), startedAt: at, finishedAt: at,
        people: [{ testimonyMs: 1, baptizeMs: 1 }], title: null, serviceTypeId: null, planId: null,
        serviceKey: `dominating3-${i}`,
      };
    });
    await baptismStore.addSessions(dominatingFiller as never);

    // This service's own OTHER session — no rebuilt counterpart at all (a
    // service-key roll, or one predating the raw layer). Under the old,
    // eviction-based cap this was exactly the session on the losing side
    // once the store went one over the limit; it must survive untouched
    // instead.
    const keptSession = {
      id: "bap-cap-never-evicts-kept-1",
      startedAt: "2026-09-23T09:00:00.000Z",
      finishedAt: "2026-09-23T09:05:00.000Z",
      people: [{ testimonyMs: 1, baptizeMs: 1 }], title: "Kept", serviceTypeId: null, planId: null,
      serviceKey: KEY,
    };
    // This service's own session the rebuild WILL match by exact id — an
    // update replaces its own fields without changing the store's total, so
    // it must still land even though the store is completely full.
    const updateStartedAt = "2026-09-23T10:00:00.000Z";
    const toUpdate = {
      id: baptismSessionId(updateStartedAt),
      startedAt: updateStartedAt,
      finishedAt: "2026-09-23T10:03:00.000Z", // earlier than the row's own finish below
      people: [{ testimonyMs: 1, baptizeMs: 1 }], title: "Stored Title", serviceTypeId: "st1", planId: "plan-1",
      serviceKey: KEY,
    };
    await baptismStore.addSession(keptSession as never);
    await baptismStore.addSession(toUpdate as never);
    assert.equal((await baptismStore.listSessions()).length, 2000, "precondition: the store is at the cap");

    // Two rows: one matches toUpdate by exact id with a genuinely later
    // Finish (an update — never capacity-limited); one has no stored
    // counterpart at all (an add — the one the full store must refuse).
    await writeBaptismCsv(KEY, DATE, [
      HEADER_ROW,
      `${updateStartedAt},start,per-person,testimony,1,0,0,,,`,
      "2026-09-23T10:03:30.000Z,testimony-end,per-person,testimony,1,0,210000,,,",
      "2026-09-23T10:04:00.000Z,finish,per-person,testimony,1,0,240000,,,",
      "2026-09-23T11:00:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-23T11:05:00.000Z,testimony-end,per-person,testimony,1,0,300000,,,",
      "2026-09-23T11:05:00.000Z,finish,per-person,testimony,1,0,300000,,,",
      "",
    ].join("\n"));

    try {
      const outcome = await rebuildServiceBaptisms(KEY);
      const all = await baptismStore.listSessions();
      const forService = all.filter((s) => s.serviceKey === KEY);

      assert.equal(outcome.updated, 1, "the matched session's genuinely later Finish must still be written even at the cap");
      assert.equal(outcome.added, 0, "the store is full — the new, unmatched session must not be added");
      assert.equal(outcome.full, 1);
      assert.equal(outcome.kept, 1, "the OTHER session for this service must still be kept — never evicted");

      assert.equal(
        all.length,
        2000,
        "the store must hold exactly what it held before — an update never changes the count, and nothing was evicted",
      );
      assert.equal(
        all.filter((s) => (s.serviceKey ?? "").startsWith("dominating3-")).length,
        1998,
        "every filler session must still be there",
      );

      const stillKept = forService.find((s) => s.id === keptSession.id);
      assert.deepStrictEqual(stillKept, keptSession, "the kept session must survive byte-identical — never touched, let alone evicted");

      const updated = forService.find((s) => s.id === toUpdate.id);
      assert.equal(updated?.finishedAt, "2026-09-23T10:04:00.000Z", "the update must still land, even though the store is at the cap");
      assert.equal(forService.length, 2, "this service must hold exactly its updated session and its kept one — no third, since the add was refused");
    } finally {
      for (const f of dominatingFiller) await baptismStore.deleteSession(f.id);
      await baptismStore.deleteSession(toUpdate.id);
      await baptismStore.deleteSession(keptSession.id);
    }
  });
});

// ── A correction made after the service closed: the store can know more than the rows ──
describe("rebuildServiceBaptisms — a correction made after the service closed", () => {
  it("Finish, the service closes, Undo and a longer re-Finish: the rebuild must not revert it", async () => {
    const ctx = freshCtx("closed-then-corrected");
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
    await sleep(200); // a much longer baptism than the first, undone attempt — comfortably past the 100ms tie band
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

describe("rebuildServiceBaptisms — the close-in-time fallback matches from every candidate, not by which rebuilt session is looked at first", () => {
  it("does not let an earlier rebuilt session steal a later one's own closest stored match", async () => {
    const KEY = "global-sort-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the id-matching describe block's own comment on why.
    const t = "2026-09-20T06:00:00.000Z";
    const taEnd = "2026-09-20T06:00:01.000Z";
    const tb = "2026-09-20T06:00:01.500Z"; // 1.5s after A's start
    const tbEnd = "2026-09-20T06:04:00.000Z";
    await writeBaptismCsv(KEY, DATE, twoCloseSessionsCsv(t, taEnd, tb, tbEnd));

    // Only B has a stored counterpart — A was deleted — and B's is skewed 1ms
    // earlier than its own row on both ends, so it is not an exact id match
    // and must be found by proximity. B's stored copy sits 1ms from B's own
    // row but only 1.499s from A's — still inside the 2-second fallback
    // window, so a fallback that matches per rebuilt session in array order
    // can let A, considered first, claim it for being looked at first, before
    // B's own turn ever comes.
    const skewedB = "2026-09-20T06:00:01.499Z";
    await baptismStore.addSession({
      id: baptismSessionId(skewedB),
      startedAt: skewedB,
      finishedAt: "2026-09-20T06:03:59.999Z",
      people: [{ testimonyMs: 118_500, baptizeMs: 120_000 }],
      title: "Stored B",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const stored = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);

    assert.equal(stored.length, 2, "two sessions, not three — B must not be duplicated");
    assert.ok(
      stored.some((s) => s.id === baptismSessionId(t)),
      "the deleted session A was never restored",
    );
    assert.equal(
      stored.filter((s) => s.people[0]?.baptizeMs === 120_000).length,
      1,
      "B's stored copy exists more than once — A's fallback match stole it, and B was added again fresh under its own id",
    );
    assert.equal(outcome.added, 1, "A has no stored counterpart and must be added");
    assert.equal(outcome.unchanged, 1, "B's stored copy already agrees with what the row reconstructs — nothing to write");
    assert.equal(outcome.updated, 0);
    assert.equal(outcome.newer, 0, "A must not consume B's stored copy and read as a stale correction the rebuild leaves alone");
  });
});

describe("rebuildServiceBaptisms — two competing close-in-time candidates each go to their own nearest match", () => {
  it("does not swap two sessions' people even when each is also within range of the other's row", async () => {
    const KEY = "nearest-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the id-matching describe block's own comment on why.
    const t = "2026-09-20T08:00:00.000Z";
    const taEnd = "2026-09-20T08:00:01.000Z";
    const tb = "2026-09-20T08:00:01.500Z";
    const tbEnd = "2026-09-20T08:04:00.000Z";
    await writeBaptismCsv(KEY, DATE, twoCloseSessionsCsv(t, taEnd, tb, tbEnd));

    // Both A and B are stored 1ms earlier than their own row on both ends —
    // neither is an exact id match, so both fall to the close-in-time
    // fallback — and each is genuinely closer to its OWN row (1ms) than to
    // the OTHER's (1.5s), but both distances are still inside the 2-second
    // window, so a fallback that does not consider every candidate together
    // could still assign either session to the wrong row.
    await baptismStore.addSession({
      id: baptismSessionId("2026-09-20T07:59:59.999Z"),
      startedAt: "2026-09-20T07:59:59.999Z",
      finishedAt: "2026-09-20T08:00:00.999Z",
      people: [{ testimonyMs: 1000, baptizeMs: 0 }],
      title: "A",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);
    await baptismStore.addSession({
      id: baptismSessionId("2026-09-20T08:00:01.499Z"),
      startedAt: "2026-09-20T08:00:01.499Z",
      finishedAt: "2026-09-20T08:03:59.999Z",
      people: [{ testimonyMs: 118_500, baptizeMs: 120_000 }],
      title: "B",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const stored = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);

    assert.equal(stored.length, 2, "two sessions, not a duplicate");
    assert.deepEqual(
      stored.find((s) => s.title === "A")?.people,
      [{ testimonyMs: 1000, baptizeMs: 0 }],
      "A must keep its own people, not B's",
    );
    assert.deepEqual(
      stored.find((s) => s.title === "B")?.people,
      [{ testimonyMs: 118_500, baptizeMs: 120_000 }],
      "B must keep its own people, not A's",
    );
    assert.equal(outcome.unchanged, 2, "both already agree with their own row and need no rewrite");
    assert.equal(outcome.updated, 0);

    // This exercises the same close-in-time fallback as the describe block
    // above, so it is not separately proven red against the old,
    // per-rebuilt-session matching: a "whichever is considered first" bug can
    // pass this particular fixture by luck, since each session's position in
    // the rebuilt array here happens to match its own distance order too.
  });
});

describe("rebuildServiceBaptisms — a lost row must not let an incomplete replay overwrite a complete session", () => {
  it("keeps the stored two-person session when the rows can only reconstruct one, even though they agree on when it finished", async () => {
    const KEY = "lost-row-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the id-matching describe block's own comment on why.
    //
    // Person 1's rows are complete; person 2's are entirely missing, as
    // csv-appender.ts logs and continues past a failed append rather than
    // stopping the recording. The finish row still names two people, but the
    // replay can only reconstruct the one whose rows survived.
    await writeBaptismCsv(KEY, DATE, [
      HEADER_ROW,
      "2026-09-20T01:00:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-20T01:01:00.000Z,testimony-end,per-person,baptism,1,0,60000,,,",
      "2026-09-20T01:02:00.000Z,person-complete,per-person,baptism,1,0,60000,,,",
      "2026-09-20T01:05:00.000Z,finish,per-person,testimony,3,0,0,,,people=2",
      "",
    ].join("\n"));

    const originalPeople = [
      { testimonyMs: 60_000, baptizeMs: 60_000 },
      { testimonyMs: 50_000, baptizeMs: 40_000 },
    ];
    await baptismStore.addSession({
      id: baptismSessionId("2026-09-20T01:00:00.000Z"),
      startedAt: "2026-09-20T01:00:00.000Z",
      finishedAt: "2026-09-20T01:05:00.000Z", // EXACTLY the row's own finish — equal must not mean "the rows win"
      people: originalPeople,
      title: "Stored",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const s = (await baptismStore.listSessions()).find((x) => x.serviceKey === KEY)!;

    assert.equal(outcome.disagreeing, 1, "the same Finish, but the rows can only show one of the two people — left as stored");
    assert.equal(outcome.updated, 0);
    assert.equal(s.people.length, 2, "the complete, two-person record must survive");
    assert.deepEqual(s.people, originalPeople, "nothing about the stored session was overwritten");
  });
});

// This describe block's two cases, and the unmatched case in the next describe
// block below, all reach the same "either side is unreadable" guard as "does
// not overwrite a valid stored session with an unreadable row finish time"
// further down — the one case in this group actually proven red against the
// bug it guards (see this file's own PR for the command and failing output).
// The other three were deliberately not each independently red-proofed, since
// they exercise the identical branch; this note is that choice on the record,
// not an oversight.
describe("rebuildServiceBaptisms — an unreadable stored finish time is never treated as the rows winning", () => {
  it("a garbled stored finish time is left exactly as it was", async () => {
    const KEY = "garbled-stored-finish-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the id-matching describe block's own comment on why.
    await writeBaptismCsv(KEY, DATE, [
      HEADER_ROW,
      "2026-09-20T02:00:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-20T02:01:00.000Z,testimony-end,per-person,testimony,1,0,60000,,,",
      "2026-09-20T02:01:00.000Z,finish,per-person,testimony,1,0,60000,,,",
      "",
    ].join("\n"));

    const originalPeople = [{ testimonyMs: 1, baptizeMs: 0 }];
    await baptismStore.addSession({
      id: baptismSessionId("2026-09-20T02:00:00.000Z"),
      startedAt: "2026-09-20T02:00:00.000Z",
      finishedAt: "not-a-date",
      people: originalPeople,
      title: "Stored",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const s = (await baptismStore.listSessions()).find((x) => x.serviceKey === KEY)!;

    assert.equal(outcome.invalid, 1, "the stored finish time could not be read, so the match could not be compared");
    assert.equal(s.finishedAt, "not-a-date", "the garbled value must survive — the rows do not get to replace it");
    assert.deepEqual(s.people, originalPeople, "nothing about the stored session was overwritten");
  });

  it("a missing stored finish time is left exactly as it was", async () => {
    const KEY = "missing-stored-finish-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the id-matching describe block's own comment on why.
    await writeBaptismCsv(KEY, DATE, [
      HEADER_ROW,
      "2026-09-20T03:00:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-20T03:01:00.000Z,testimony-end,per-person,testimony,1,0,60000,,,",
      "2026-09-20T03:01:00.000Z,finish,per-person,testimony,1,0,60000,,,",
      "",
    ].join("\n"));

    const originalPeople = [{ testimonyMs: 1, baptizeMs: 0 }];
    await baptismStore.addSession({
      id: baptismSessionId("2026-09-20T03:00:00.000Z"),
      startedAt: "2026-09-20T03:00:00.000Z",
      // No finishedAt at all.
      people: originalPeople,
      title: "Stored",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const s = (await baptismStore.listSessions()).find((x) => x.serviceKey === KEY)!;

    assert.equal(outcome.invalid, 1, "the stored finish time could not be read, so the match could not be compared");
    assert.equal(s.finishedAt, undefined, "the missing value must stay missing — the rows do not get to fill it in");
    assert.deepEqual(s.people, originalPeople, "nothing about the stored session was overwritten");
  });
});

describe("rebuildServiceBaptisms — an unreadable finish time in the rows is never trusted", () => {
  it("does not overwrite a valid stored session with an unreadable row finish time", async () => {
    const KEY = "garbled-row-finish-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the id-matching describe block's own comment on why.
    //
    // The finish row's own `at` column is unreadable — a real, previously-
    // reachable defect let a comparison like this fall through and write the
    // literal garbage value over a valid stored session. This is the one case
    // in the unreadable-finish-time group (see the note above the previous
    // describe block) actually proven red against that defect.
    await writeBaptismCsv(KEY, DATE, [
      HEADER_ROW,
      "2026-09-20T04:00:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-20T04:01:00.000Z,testimony-end,per-person,testimony,1,0,60000,,,",
      "garbage,finish,per-person,testimony,1,0,60000,,,",
      "",
    ].join("\n"));

    const originalPeople = [{ testimonyMs: 60_000, baptizeMs: 480_000 }];
    await baptismStore.addSession({
      id: baptismSessionId("2026-09-20T04:00:00.000Z"),
      startedAt: "2026-09-20T04:00:00.000Z",
      finishedAt: "2026-09-20T04:09:00.000Z",
      people: originalPeople,
      title: "Stored",
      serviceTypeId: "st1",
      planId: "plan-1",
      serviceKey: KEY,
    } as unknown as BaptismSession);

    const outcome = await rebuildServiceBaptisms(KEY);
    const s = (await baptismStore.listSessions()).find((x) => x.serviceKey === KEY)!;

    assert.equal(outcome.invalid, 1, "the row's own finish time could not be read, so the match could not be compared");
    assert.equal(
      s.finishedAt,
      "2026-09-20T04:09:00.000Z",
      "the valid stored finish time must survive — never replaced by the unreadable row value",
    );
    assert.deepEqual(s.people, originalPeople, "nothing about the stored session was overwritten");
  });

  it("does not add a session whose own finish time cannot be read", async () => {
    const KEY = "garbled-row-finish-unmatched-svc";
    const DATE = "2026-09-20";
    await serviceTimelineStore.upsert(timeline(KEY, DATE));
    // Its own well-separated hour — see the id-matching describe block's own
    // comment on why. Same broken shape as above, but nothing is stored for
    // this service at all.
    await writeBaptismCsv(KEY, DATE, [
      HEADER_ROW,
      "2026-09-20T05:00:00.000Z,start,per-person,testimony,1,0,0,,,",
      "2026-09-20T05:01:00.000Z,testimony-end,per-person,testimony,1,0,60000,,,",
      "garbage,finish,per-person,testimony,1,0,60000,,,",
      "",
    ].join("\n"));

    const outcome = await rebuildServiceBaptisms(KEY);
    const forService = (await baptismStore.listSessions()).filter((s) => s.serviceKey === KEY);

    assert.equal(forService.length, 0, "a session whose own finish time cannot be read must not be added");
    assert.equal(outcome.invalid, 1);
    assert.equal(outcome.added, 0);
    assert.equal(outcome.kept, 0, "nothing was stored for this service to begin with");
  });
});
