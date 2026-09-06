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
  startedAt: string;
  endedAt: string | null;
  counted?: boolean;
};
type Rec = { serviceKey: string; startedAt: string; endedAt: string | null; items: Item[] };
type Held = {
  current: Rec | null;
  openItem(live: Record<string, unknown>): void;
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
