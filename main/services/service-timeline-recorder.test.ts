// A live PCO item left running since a PREVIOUS session must not backdate a new
// recording's pacing baseline.
//
// The incident (2026-09-06): the live timeline record for today's service opened
// at 12:57:57Z, but Planning Center Live had been sitting on BENEDICTION since
// Thursday night. openItem() took `startedAt: live.liveStartAt ?? now` verbatim,
// so the record's first item adopted a start two days before the record itself
// existed, and the Service pacing widget read +2d 10h.
//
// Driven directly against openItem() (private, reached via a cast) rather than
// through onLiveTick — what's under test is the clamp inside item-open, not the
// transition machinery around it, which recorder-forget.test.ts already covers.

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-timeline-carryover-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { serviceTimelineRecorder } = await import("./service-timeline-recorder.js");

type Item = {
  itemId: string;
  title: string;
  sequence: number;
  plannedLengthSec: number | null;
  startedAt: string;
  endedAt: string | null;
  actualDurationSec: number | null;
  counted?: boolean;
};
type Rec = { serviceKey: string; startedAt: string; endedAt: string | null; items: Item[] };
type Held = {
  current: Rec | null;
  lastItemId: string | null;
  nextSequence: number;
  openItem(live: Record<string, unknown>): void;
  finalizePrevItem(): void;
};

function baseLive(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: "item",
    currentItemId: "item-1",
    label: "BENEDICTION",
    itemType: null,
    lengthSec: 90,
    liveStartAt: null,
    targetAt: null,
    serverNow: new Date().toISOString(),
    currentItemTitle: null,
    nextItemTitle: null,
    serviceTimeId: null,
    serviceTimeStartsAt: null,
    beforeServiceStart: false,
    ...overrides,
  };
}

describe("service-timeline-recorder: leftover PCO item does not backdate the record", () => {
  const rec = serviceTimelineRecorder as unknown as Held;
  const RECORD_STARTED_AT = "2026-09-06T12:57:57.000Z"; // today's record opened
  let logs: unknown[][] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    rec.current = {
      serviceKey: "st1:plan:11am",
      startedAt: RECORD_STARTED_AT,
      endedAt: null,
      items: [],
    };
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("clamps a leftover item's start to the record's own and marks it not counted", () => {
    // BENEDICTION had been live since Thursday night — more than two days
    // before this record opened.
    const THURSDAY_LIVE_START = "2026-09-04T01:43:18.000Z";
    rec.openItem(baseLive({ liveStartAt: THURSDAY_LIVE_START }));

    const item = rec.current!.items[0]!;
    // The guard this proves: without the clamp, item.startedAt would be
    // THURSDAY_LIVE_START — an assertion failure here shows that exact
    // Thursday timestamp as the "actual" value.
    assert.equal(item.startedAt, RECORD_STARTED_AT, "adopted the leftover PCO start instead of the record's own");
    assert.equal(item.counted, false, "a carried-over item must not count toward pacing");

    const carryoverLogs = logs.filter((a) => String(a[0]).includes("[service-timeline]") && String(a[0]).includes("carried over"));
    assert.equal(carryoverLogs.length, 1, "expected exactly one carry-over log line");
    const msg = String(carryoverLogs[0]![0]);
    assert.match(msg, /"BENEDICTION"/);
    assert.match(msg, /2d \d+h/, `expected a day-scale duration in: ${msg}`);
    assert.match(msg, /carried over from an earlier session, not counted/);
  });

  it("leaves an item that went live within the same-service gap unchanged", () => {
    const thirtySecondsEarlier = new Date(Date.parse(RECORD_STARTED_AT) - 30_000).toISOString();
    rec.openItem(baseLive({ liveStartAt: thirtySecondsEarlier }));

    const item = rec.current!.items[0]!;
    assert.equal(item.startedAt, thirtySecondsEarlier, "PCO's own start should be kept");
    assert.equal(item.counted, undefined, "an ordinary item must not be forced counted=false");
    assert.equal(logs.filter((a) => String(a[0]).includes("carried over")).length, 0);
  });
});

// A plan item running a SECOND time must not rewrite the first run.
//
// The incident (18 Sep 2026): with two services on one plan merged into a single
// record (see service-recorder.test.ts), the second service's items were matched
// by itemId and took the "operator stepped back — reopen it" path. Doors, run at
// 23:23 and again at 00:43, ended up as ONE entry reading 23:23:46 → 01:16:19,
// 6753 s. The occurrence split now prevents that, and this is the second line of
// defence: even inside one record, a run that finished more than SERVICE_GAP_MS
// ago is history, not something to reopen.
//
// Driven against openItem/finalizePrevItem directly, as above.
describe("service-timeline-recorder: a re-run item gets its own entry", () => {
  const rec = serviceTimelineRecorder as unknown as Held;
  const RECORD_STARTED_AT = "2026-09-18T23:23:46.000Z";

  function firstRun(endedAt: string | null): Item {
    return {
      itemId: "doors",
      title: "Doors",
      sequence: 0,
      plannedLengthSec: 378,
      startedAt: RECORD_STARTED_AT,
      endedAt,
      actualDurationSec: endedAt == null ? null : 497,
    };
  }

  beforeEach(() => {
    rec.current = { serviceKey: "st1:plan:occ-1", startedAt: RECORD_STARTED_AT, endedAt: null, items: [] };
    rec.nextSequence = 1;
    rec.lastItemId = null;
  });

  it("pushes a new entry when the same item goes live again long after its last run", () => {
    rec.current!.items = [firstRun("2026-09-18T23:32:03.000Z")];
    // The second service's Doors, 1h 11m after the first run closed.
    rec.openItem(baseLive({ currentItemId: "doors", label: "Doors", liveStartAt: "2026-09-19T00:43:15.000Z" }));

    assert.equal(rec.current!.items.length, 2, "the re-run reopened the first run instead of starting its own entry");
    const first = rec.current!.items[0]!;
    assert.equal(first.endedAt, "2026-09-18T23:32:03.000Z", "the first run's end was cleared");
    assert.equal(first.actualDurationSec, 497, "the first run's duration was rewritten");
    assert.equal(first.startedAt, RECORD_STARTED_AT);

    const second = rec.current!.items[1]!;
    assert.equal(second.itemId, "doors");
    assert.equal(second.startedAt, "2026-09-19T00:43:15.000Z");
    assert.equal(second.endedAt, null);
    assert.equal(second.sequence, 1);
  });

  it("reopens on a genuine step back, within the gap", () => {
    rec.current!.items = [firstRun("2026-09-18T23:32:03.000Z")];
    // The operator jumps back to Doors fifty seconds after leaving it.
    rec.openItem(baseLive({ currentItemId: "doors", label: "Doors", liveStartAt: "2026-09-18T23:32:53.000Z" }));

    assert.equal(rec.current!.items.length, 1, "a step back started a duplicate entry");
    assert.equal(rec.current!.items[0]!.endedAt, null);
    assert.equal(rec.current!.items[0]!.actualDurationSec, null);
    assert.equal(rec.current!.items[0]!.startedAt, RECORD_STARTED_AT, "a reopen must keep the original start");
  });

  it("reopens an entry that was never closed, rather than duplicating it", () => {
    rec.current!.items = [firstRun(null)];
    rec.openItem(baseLive({ currentItemId: "doors", label: "Doors", liveStartAt: "2026-09-19T02:00:00.000Z" }));
    assert.equal(rec.current!.items.length, 1, "an open entry was duplicated");
  });

  // The same restart, on this recorder — the rule both now share (isStepBackTo
  // in service-recorder.ts, judged against PCO's live_start_at). An item that
  // never stopped in Planning Center is one run however long this box was away.
  it("reopens an item that has been live in PCO throughout a long restart", () => {
    const wentLiveInPco = "2026-09-18T23:23:46.000Z";
    // The box was down for half an hour; the entry closed when it went.
    rec.current!.items = [firstRun("2026-09-18T23:30:00.000Z")];
    rec.openItem(baseLive({ currentItemId: "doors", label: "Doors", liveStartAt: wentLiveInPco }));

    assert.equal(rec.current!.items.length, 1, "a restart split an item that never stopped in PCO");
    assert.equal(rec.current!.items[0]!.endedAt, null, "the run must be open again");
    assert.equal(rec.current!.items[0]!.startedAt, RECORD_STARTED_AT, "a reopen keeps the original start");
  });

  it("finalizePrevItem closes the LAST run of an id, not the first", () => {
    rec.current!.items = [firstRun("2026-09-18T23:32:03.000Z")];
    rec.openItem(baseLive({ currentItemId: "doors", label: "Doors", liveStartAt: "2026-09-19T00:43:15.000Z" }));
    rec.lastItemId = "doors";
    rec.finalizePrevItem();

    const [first, second] = rec.current!.items as [Item, Item];
    assert.equal(first.endedAt, "2026-09-18T23:32:03.000Z", "the finished first run was re-closed");
    assert.equal(first.actualDurationSec, 497, "the finished first run's duration was recomputed");
    assert.ok(second.endedAt, "the live run was left open forever");
  });
});
