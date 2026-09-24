// rebuild-baptism.test.ts — the replay rules, one fixture per emitter behaviour.
//
// These are hand-written rows, which is necessary and NOT sufficient: a fixture
// can only ever assert what its author believed the emitter writes. The guard
// that matters is rebuild-baptism-roundtrip.test.ts, which drives the real
// baptismTimerService against a real temp data dir and replays the rows it
// actually wrote. This file exists for the shapes a driven session cannot
// produce on demand — a damaged stamp, a truncated file, rows with no session —
// and to name each rule so a failure points at the rule rather than at a
// session.
//
// Every fixture below was transcribed from a real driven run: the `events` and
// column values in baptism-timer-raw.test.ts's own assertions. Where the
// original task brief's pseudocode disagreed with those runs, the runs won, and
// the disagreement is named in the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rebuildBaptismSessions, type BaptismRow } from "./rebuild-baptism.js";

const ID = {
  serviceKey: "st1:p1:t1",
  title: "Sunday Gathering",
  serviceTypeId: "st1",
  planId: "p1",
};

/** `t` is seconds after 11:00:00Z. Defaults match an idle grouped row, so each
 *  fixture states only the columns its rule turns on. */
const row = (t: number, over: Partial<BaptismRow>): BaptismRow => ({
  at: new Date(Date.UTC(2026, 8, 27, 11, 0, t)).toISOString(),
  event: "",
  mode: "grouped",
  phase: "",
  personNumber: "0",
  baptismIndex: "0",
  segmentMs: "0",
  itemId: "",
  item: "",
  detail: "",
  ...over,
});

const startedAtId = (t: number) => `bap-${Date.UTC(2026, 8, 27, 11, 0, t)}`;

/** Silence the one [baptism-replay] summary line a damaged fixture prints, and
 *  hand back what it said so the test can assert the operator has something to
 *  read. */
function captureWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[baptism-replay]")) warnings.push(args[0]);
    else original(...args);
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("rebuildBaptismSessions: a grouped session", () => {
  it("replays into the same people the presses produced", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(108, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "108000" }),
      // The last testimony ends by ARMING, and that row carries its duration.
      row(204, { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "96000" }),
      row(220, { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(262, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "42000" }),
      row(300, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "38000" }),
      row(300, { event: "finish", phase: "idle", detail: "people=2" }),
    ];

    const sessions = rebuildBaptismSessions(rows, ID);
    assert.equal(sessions.length, 1);
    const [session] = sessions;
    assert.deepEqual(session!.people, [
      { testimonyMs: 108000, baptizeMs: 42000 },
      { testimonyMs: 96000, baptizeMs: 38000 },
    ]);
    assert.equal(session!.id, startedAtId(0));
    assert.equal(session!.startedAt, rows[0]!.at);
    assert.equal(session!.finishedAt, rows[6]!.at);
    assert.equal(session!.serviceKey, "st1:p1:t1");
    assert.equal(session!.title, "Sunday Gathering");
    assert.equal(session!.serviceTypeId, "st1");
    assert.equal(session!.planId, "p1");
  });

  it("takes the folded testimony from baptisms-armed, which is the only place it exists", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(93, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "93000" }),
      row(120, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(session!.people, [{ testimonyMs: 93000, baptizeMs: 0 }]);
  });

  it("keys a baptism row on baptismIndex, never on the frozen personNumber", () => {
    // Both person-complete rows read personNumber=2 — the testimony counter
    // freezes once the baptisms arm. Only baptismIndex tells them apart.
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(60, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "60000" }),
      row(120, { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "60000" }),
      row(130, { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(140, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "10000" }),
      row(155, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "15000" }),
      row(155, { event: "finish", phase: "idle", detail: "people=2" }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(
      session!.people.map((p) => p.baptizeMs),
      [10000, 15000],
      "each row landed on its own person; keying on personNumber would have put both on the same one",
    );
  });
});

describe("rebuildBaptismSessions: undo", () => {
  it("takes the LAST person-complete for a re-baptized index, not the first", () => {
    // The sequence baptism-timer-raw.test.ts drives: person 0 baptized a beat
    // early, undone, baptized again. Index 0's real value is the second row.
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "20000" }),
      row(40, { event: "baptisms-armed", phase: "baptism", personNumber: "2", segmentMs: "20000" }),
      row(41, { event: "baptisms-start", phase: "baptism", personNumber: "2" }),
      row(46, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "5000" }),
      row(47, { event: "undo", phase: "baptism", personNumber: "2", baptismIndex: "0", detail: "from baptism" }),
      row(54, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "0", segmentMs: "7000" }),
      row(59, { event: "person-complete", phase: "baptism", personNumber: "2", baptismIndex: "1", segmentMs: "5000" }),
      row(59, { event: "finish", phase: "idle", detail: "people=2" }),
    ];

    const [session] = rebuildBaptismSessions(rows, ID);
    assert.equal(session!.people.length, 2, "three person-complete rows describe two people, not three");
    assert.equal(session!.people[0]!.baptizeMs, 7000, "the corrected attempt replaces the undone one");
    assert.equal(session!.people[1]!.baptizeMs, 5000);
  });

  it("assigns at the index rather than writing it once, with no undo row to lean on", () => {
    // The rule is "assign at baptismIndex", and while the undo row is present
    // a first-write-wins reading is INDISTINGUISHABLE from it: the undo puts
    // the index back to 0, so the second attempt writes into a zero either
    // way. This drops the undo row so the two readings differ, and is the only
    // thing in the suite that pins assignment on its own. baptismIndex only
    // ever moves forward within a section, so two rows for one index cannot
    // occur live without an undo — but the rule must not depend on a row that
    // a merge or a rewrite of the file might not carry.
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(26, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
      row(33, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "7000" }),
      row(33, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(session!.people, [{ testimonyMs: 20000, baptizeMs: 7000 }], "the LAST row for an index wins");
  });

  it("pops the person baptisms-armed folded in, so arm/undo/re-arm is one person", () => {
    // The shape the original brief did not describe at all. Without the pop,
    // the second baptisms-armed row appends a SECOND entry for the same person
    // and a one-person service replays as two.
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(3, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "3000" }),
      row(4, { event: "undo", phase: "testimony", personNumber: "1", detail: "from baptism" }),
      row(8, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "8000" }),
      row(9, { event: "finish", phase: "idle", detail: "people=1" }),
    ];

    const [session] = rebuildBaptismSessions(rows, ID);
    assert.equal(session!.people.length, 1, "a one-person service must replay as one person, not two");
    assert.equal(session!.people[0]!.testimonyMs, 8000, "the re-arm's resumed total, not the first arm's");
  });

  it("un-baptizes the person the undo row NAMES, not whoever is at index 0", () => {
    // Every other undo in this suite steps back at baptismIndex 0, where the
    // row's index and a hardcoded 0 are the same number — so replacing
    // `num(r.baptismIndex)` with `0` left the whole suite green while silently
    // zeroing person 0's baptism on any service where the operator corrected
    // somebody later in the line. Three people, undone at index 1.
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(12, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "12000" }),
      row(24, { event: "testimony-end", phase: "testimony", personNumber: "2", segmentMs: "12000" }),
      row(35, { event: "baptisms-armed", phase: "baptism", personNumber: "3", segmentMs: "11000" }),
      row(36, { event: "baptisms-start", phase: "baptism", personNumber: "3" }),
      row(48, { event: "person-complete", phase: "baptism", personNumber: "3", baptismIndex: "0", segmentMs: "12000" }),
      row(60, { event: "person-complete", phase: "baptism", personNumber: "3", baptismIndex: "1", segmentMs: "12000" }),
      // The correction: back to person 1 (index 1), whose clock is zeroed.
      row(61, { event: "undo", phase: "baptism", personNumber: "3", baptismIndex: "1", detail: "from baptism" }),
      row(103, { event: "person-complete", phase: "baptism", personNumber: "3", baptismIndex: "1", segmentMs: "42000" }),
      row(114, { event: "person-complete", phase: "baptism", personNumber: "3", baptismIndex: "2", segmentMs: "11000" }),
      row(114, { event: "finish", phase: "idle", detail: "people=3" }),
    ];

    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(
      session!.people,
      [
        { testimonyMs: 12000, baptizeMs: 12000 },
        { testimonyMs: 12000, baptizeMs: 42000 },
        { testimonyMs: 11000, baptizeMs: 11000 },
      ],
      "person 0's baptism must survive an undo aimed at person 1",
    );
  });

  it("pops a completed grouped testimony that next() closed a beat early", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(150, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "150000" }),
      row(170, { event: "undo", phase: "testimony", personNumber: "1", detail: "from testimony" }),
      row(210, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "210000" }),
      row(211, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(session!.people, [{ testimonyMs: 210000, baptizeMs: 0 }]);
  });

  it("reads the same (phase, detail) pair the other way round in per-person mode", () => {
    // `phase=testimony detail="from baptism"` pops the folded person in grouped
    // mode. In per-person mode the identical pair pops NOBODY — it un-baptizes,
    // putting the banked testimony back on the running clock. A replay that
    // switched on detail alone would delete person 1 here.
    const pp = { mode: "per-person" };
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1", ...pp }),
      row(150, { event: "testimony-end", phase: "baptism", personNumber: "1", segmentMs: "150000", ...pp }),
      row(151, { event: "undo", phase: "testimony", personNumber: "1", detail: "from baptism", ...pp }),
      row(190, { event: "testimony-end", phase: "baptism", personNumber: "1", segmentMs: "190000", ...pp }),
      row(200, { event: "person-complete", phase: "baptism", personNumber: "1", segmentMs: "10000", ...pp }),
      row(200, { event: "finish", phase: "idle", detail: "people=1", ...pp }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(session!.people, [{ testimonyMs: 190000, baptizeMs: 10000 }]);
  });

  it("gives a popped per-person person their testimony back as the pending one", () => {
    const pp = { mode: "per-person" };
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1", ...pp }),
      row(60, { event: "testimony-end", phase: "baptism", personNumber: "1", segmentMs: "60000", ...pp }),
      row(70, { event: "person-complete", phase: "baptism", personNumber: "1", segmentMs: "10000", ...pp }),
      // next() moved on too soon: step back into person 1's baptism.
      row(71, { event: "undo", phase: "baptism", personNumber: "1", detail: "from testimony", ...pp }),
      row(85, { event: "person-complete", phase: "baptism", personNumber: "1", segmentMs: "14000", ...pp }),
      row(85, { event: "finish", phase: "idle", detail: "people=1", ...pp }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(
      session!.people,
      [{ testimonyMs: 60000, baptizeMs: 14000 }],
      "the popped person's testimony came back with them, rather than replaying as 0",
    );
  });
});

describe("rebuildBaptismSessions: per-person testimony-end means two different things", () => {
  it("banks the testimony when the state had already moved into the baptism phase", () => {
    const pp = { mode: "per-person" };
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1", ...pp }),
      row(60, { event: "testimony-end", phase: "baptism", personNumber: "1", segmentMs: "60000", ...pp }),
      row(75, { event: "person-complete", phase: "baptism", personNumber: "1", segmentMs: "15000", ...pp }),
      row(75, { event: "finish", phase: "idle", detail: "people=1", ...pp }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(
      session!.people,
      [{ testimonyMs: 60000, baptizeMs: 15000 }],
      "one person, whose testimony and baptism came from two different rows",
    );
  });

  it("pushes a person when finish() closed a testimony that never reached a baptism", () => {
    const pp = { mode: "per-person" };
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1", ...pp }),
      // finish() emits before finalize() runs, so the phase is still testimony.
      row(60, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "60000", ...pp }),
      row(60, { event: "finish", phase: "idle", detail: "people=1", ...pp }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(session!.people, [{ testimonyMs: 60000, baptizeMs: 0 }]);
  });
});

describe("rebuildBaptismSessions: session boundaries", () => {
  it("keys the mode off the start row, not the first row of the file", () => {
    // reset() emits AFTER clearing state and setMode() emits nothing, so a
    // per-person session routinely opens with a `reset` row reading grouped.
    // Read as grouped, the testimony-end below pushes a person with no baptism
    // and the person-complete lands on them rather than on a second one.
    //
    // Two people, deliberately: per-person rows leave `baptismIndex` at 0
    // throughout (nothing in that mode ever moves it), so a one-person session
    // misread as grouped reconstructs the right answer by luck — both readings
    // land on people[0]. With two people the misreading collapses them.
    const pp = { mode: "per-person" };
    const rows: BaptismRow[] = [
      row(0, { event: "reset", phase: "idle", mode: "grouped" }),
      row(1, { event: "start", phase: "testimony", personNumber: "1", ...pp }),
      row(61, { event: "testimony-end", phase: "baptism", personNumber: "1", segmentMs: "60000", ...pp }),
      row(76, { event: "person-complete", phase: "baptism", personNumber: "1", segmentMs: "15000", ...pp }),
      row(126, { event: "testimony-end", phase: "baptism", personNumber: "2", segmentMs: "50000", ...pp }),
      row(138, { event: "person-complete", phase: "baptism", personNumber: "2", segmentMs: "12000", ...pp }),
      row(138, { event: "finish", phase: "idle", detail: "people=2", ...pp }),
    ];
    const [session] = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(
      session!.people,
      [
        { testimonyMs: 60000, baptizeMs: 15000 },
        { testimonyMs: 50000, baptizeMs: 12000 },
      ],
      "the stale grouped mode on the reset row must not decide the replay",
    );
  });

  it("treats finish, undo, finish as ONE session with the second finish's values", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(26, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
      row(26, { event: "finish", phase: "idle", detail: "people=1" }),
      row(27, { event: "undo", phase: "baptism", personNumber: "1", baptismIndex: "0", detail: "from idle" }),
      row(35, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "8000" }),
      row(35, { event: "finish", phase: "idle", detail: "people=1" }),
    ];

    const sessions = rebuildBaptismSessions(rows, ID);
    assert.equal(sessions.length, 1, "one session, the way addSession replaces by id rather than prepending");
    assert.equal(sessions[0]!.people[0]!.baptizeMs, 8000, "the re-finish replaced the first finish's value");
    assert.equal(sessions[0]!.finishedAt, rows[7]!.at, "and its stamp");
  });

  it("keeps the first finish's snapshot when an undo is never re-finished", () => {
    // undo() writes nothing to the store, so a session finished and then undone
    // with the service ending before a second Finish is STILL on disk with its
    // pre-undo values. Replaying the post-undo state would silently zero a
    // baptism the operator's own file still records.
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(26, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
      row(26, { event: "finish", phase: "idle", detail: "people=1" }),
      row(27, { event: "undo", phase: "baptism", personNumber: "1", baptismIndex: "0", detail: "from idle" }),
    ];

    const sessions = rebuildBaptismSessions(rows, ID);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.people[0]!.baptizeMs, 5000, "the logged session kept what the finish recorded");
  });

  it("logs nothing for a finish with nobody in it", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(5, { event: "finish", phase: "idle", detail: "people=0" }),
    ];
    assert.deepEqual(rebuildBaptismSessions(rows, ID), [], "finalize() stores nothing for an empty session either");
  });

  it("abandons a session a reset cleared, and keeps one it already logged", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(26, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
      row(26, { event: "finish", phase: "idle", detail: "people=1" }),
      row(30, { event: "reset", phase: "idle" }),
      // A second session the operator abandoned without finishing.
      row(40, { event: "start", phase: "testimony", personNumber: "1" }),
      row(60, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "20000" }),
      row(70, { event: "reset", phase: "idle" }),
      // Orphans AFTER the last reset. Without them this test could not fail on
      // a reset that closed nothing: the `start` above re-opens the session
      // anyway, and a session with no `finish` is unlogged either way. These
      // are the rows that make the reset load-bearing — replayed into the
      // session the reset should have closed, they invent a second one.
      row(80, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "10000" }),
      row(81, { event: "finish", phase: "idle", detail: "people=2" }),
    ];
    const { value: sessions, warnings } = captureWarnings(() => rebuildBaptismSessions(rows, ID));
    assert.equal(sessions.length, 1, "only the session that finished before the reset is logged");
    assert.equal(sessions[0]!.id, startedAtId(0));
    assert.deepEqual(sessions[0]!.people, [{ testimonyMs: 20000, baptizeMs: 5000 }]);
    assert.match(warnings[0]!, /2 row\(s\) belonging to no started session/);
  });

  it("a reset closes the session outright, so later rows cannot rejoin it", () => {
    // The smallest shape that separates a working reset from a no-op one. It
    // comes off a damaged or merged file, which is the case this whole module
    // exists for: with the reset honoured the orphans are reported and dropped,
    // without it they graft a two-person session onto a session the operator
    // threw away.
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(12, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "12000" }),
      row(13, { event: "reset", phase: "idle" }),
      row(30, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "17000" }),
      row(31, { event: "finish", phase: "idle", detail: "people=2" }),
    ];
    const { value: sessions, warnings } = captureWarnings(() => rebuildBaptismSessions(rows, ID));
    assert.deepEqual(sessions, [], "the reset threw the session away; nothing after it rebuilds one");
    assert.match(warnings[0]!, /2 row\(s\) belonging to no started session/);
  });

  it("starts a second session fresh rather than carrying the first one's people", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(26, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
      row(26, { event: "finish", phase: "idle", detail: "people=1" }),
      row(60, { event: "start", phase: "testimony", personNumber: "1" }),
      row(80, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(81, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const sessions = rebuildBaptismSessions(rows, ID);
    assert.deepEqual(
      sessions.map((s) => [s.id, s.people.length]),
      [
        [startedAtId(0), 1],
        [startedAtId(60), 1],
      ],
      "two one-person services, not a second one carrying the first's person",
    );
  });

  it("returns nothing for rows that never started a session", () => {
    assert.deepEqual(rebuildBaptismSessions([], ID), []);
  });

  it("orders rows by time before replaying them", () => {
    // readArchiveRows walks rolled files in roll order, which is not guaranteed
    // to be time order after a history merge rewrites them.
    const ordered: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(26, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "0", segmentMs: "5000" }),
      row(26, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const shuffled = [ordered[3]!, ordered[0]!, ordered[4]!, ordered[2]!, ordered[1]!];
    assert.deepEqual(rebuildBaptismSessions(shuffled, ID), rebuildBaptismSessions(ordered, ID));
  });
});

describe("rebuildBaptismSessions: a damaged file says what it dropped", () => {
  it("drops a session whose start row has an unreadable stamp, and logs it", () => {
    const rows: BaptismRow[] = [
      { ...row(0, { event: "start", phase: "testimony", personNumber: "1" }), at: "not-a-date" },
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const { value, warnings } = captureWarnings(() => rebuildBaptismSessions(rows, ID));
    assert.deepEqual(value, [], "no startedAt means no id, and bap-NaN would duplicate on every rebuild");
    assert.equal(warnings.length, 1, "an operator has one line to read, not one per row");
    assert.match(warnings[0]!, /unreadable timestamp/);
  });

  it("ignores a baptismIndex with nobody at it rather than inventing a person", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "20000" }),
      row(21, { event: "baptisms-start", phase: "baptism", personNumber: "1" }),
      row(26, { event: "person-complete", phase: "baptism", personNumber: "1", baptismIndex: "4", segmentMs: "5000" }),
      row(26, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const { value, warnings } = captureWarnings(() => rebuildBaptismSessions(rows, ID));
    assert.deepEqual(value[0]!.people, [{ testimonyMs: 20000, baptizeMs: 0 }]);
    assert.match(warnings[0]!, /nobody at it/);
  });

  it("counts rows that belong to no session and says so once", () => {
    // A file truncated at the front, or a service opened mid-session: the timer
    // had no session to record these against either.
    const rows: BaptismRow[] = [
      row(10, { event: "testimony-end", phase: "testimony", personNumber: "1", segmentMs: "10000" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "10000" }),
      row(21, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const { value, warnings } = captureWarnings(() => rebuildBaptismSessions(rows, ID));
    assert.deepEqual(value, []);
    assert.match(warnings[0]!, /3 row\(s\) belonging to no started session/);
  });

  it("says nothing at all about an undamaged file", () => {
    const rows: BaptismRow[] = [
      row(0, { event: "reset", phase: "idle" }),
      row(1, { event: "start", phase: "testimony", personNumber: "1" }),
      row(20, { event: "baptisms-armed", phase: "baptism", personNumber: "1", segmentMs: "19000" }),
      row(21, { event: "finish", phase: "idle", detail: "people=1" }),
    ];
    const { warnings } = captureWarnings(() => rebuildBaptismSessions(rows, ID));
    assert.deepEqual(warnings, [], "a leading reset row is ordinary, not a defect worth a log line");
  });
});
