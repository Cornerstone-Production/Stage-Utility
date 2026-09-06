// A caption's age, not just the buffer's count, decides whether it belongs on
// a display.
//
// Prod's transcript buffer was found holding exactly 100 finished lines: 50
// from today and 50 from three days ago. Two bugs combined to produce this:
//
//   1. backfill() runs on every (re)connect, fetches ProdCom's own
//      /api/v1/transcript history, and used to addFinal() every row in it
//      regardless of age. ProdCom's history still held a service from days
//      earlier, so a reconnect re-imported it.
//   2. The buffer dropped lines only by COUNT (MAX_LINES), never by age, so an
//      old line stayed in the rolling window until 100 newer ones displaced
//      it — which, on a quiet integration, can be never.
//
// This is live captions, not history (History has its own records) — a
// caption older than LINE_MAX_AGE_MS is never wanted on a display, whether it
// arrived via backfill or via the live stream and simply sat there.
//
// Same harness as prodcom-stale-partial.test.ts: a subclass with a
// controllable clock, driving the real handleEvent()/applyBackfillRows() entry
// points rather than hand-built buffer state.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addBroadcastListener } from "./broadcaster.js";
import { ProdComService } from "./prodcom-service.js";

/** The service with a clock we control and its event entry points exposed. */
class TestProdCom extends ProdComService {
  public clock = 1_000_000;
  protected override now(): number {
    return this.clock;
  }
  public feed(payload: Record<string, unknown>): void {
    this.handleEvent(`data: ${JSON.stringify(payload)}`);
  }
  public backfillRows(rows: unknown[]): void {
    this.applyBackfillRows(rows);
  }
  public lines(): { text: string; isFinal: boolean }[] {
    return this.getBuffer().map((l) => ({ text: l.text, isFinal: l.isFinal }));
  }
  /** Whether the background sweep is currently armed — see prodcom-service.ts. */
  public get sweepActive(): boolean {
    return this.partialSweepActive;
  }
}

/** Collects every "prodcom:transcript" broadcast fired while a test runs. See
 *  prodcom-stale-partial.test.ts for why each spy is scoped to its own array. */
function spyOnTranscriptBroadcasts(): unknown[] {
  const seen: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "prodcom:transcript") seen.push(payload);
  });
  return seen;
}

/** A finalised line with an explicit `date`, so its age is driven by the
 *  fictional test clock rather than the real wall clock normalizeLine() falls
 *  back to when a payload carries no timestamp field. */
const final = (channelId: string, text: string, at: number) => ({
  id: `${channelId}-${text}`, channelId, channelName: channelId, text, inProgress: false,
  date: new Date(at).toISOString(),
});

/** A backfill row shaped like ProdCom's history snapshot, same reasoning. */
const backfillRow = (id: string, text: string, at: number) => ({
  id, channelId: "EM", channelName: "EM", text, inProgress: false, date: new Date(at).toISOString(),
});

describe("backfill skips ProdCom history older than the horizon", () => {
  it("keeps a 2-minute-old row and skips a 64-hour-old row, logging once", () => {
    const svc = new TestProdCom();
    const logs = { calls: [] as unknown[][] };
    const original = console.log;
    console.log = (...args: unknown[]) => logs.calls.push(args);

    try {
      svc.backfillRows([
        backfillRow("old", "Thursday's sermon", svc.clock - 64 * 60 * 60_000),
        backfillRow("recent", "this morning's welcome", svc.clock - 2 * 60_000),
      ]);
    } finally {
      console.log = original;
    }

    const lines = svc.lines();
    assert.equal(lines.length, 1, `expected only the recent row, got: ${JSON.stringify(lines)}`);
    assert.equal(lines[0].text, "this morning's welcome");

    const skipLogs = logs.calls
      .map((args) => args[0])
      .filter((a): a is string => typeof a === "string" && a.startsWith("[prodcom] backfill skipped"));
    assert.equal(skipLogs.length, 1, `expected exactly one skip log, got: ${JSON.stringify(skipLogs)}`);
    assert.equal(skipLogs[0], "[prodcom] backfill skipped 1 line(s) older than 4h");
  });

  // Guard proof: with the age filter removed from applyBackfillRows() (i.e. every
  // row added regardless of `at`), this assertion goes red — lines.length is 2,
  // not 1, and the 64-hour-old "Thursday's sermon" line is present.
});

describe("a final ages out of the live buffer on its own", () => {
  it("disappears once it crosses the 4-hour horizon, with a broadcast and a log line", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const svc = new TestProdCom();
    const broadcasts = spyOnTranscriptBroadcasts();
    const logs = { calls: [] as unknown[][] };
    const original = console.log;
    console.log = (...args: unknown[]) => logs.calls.push(args);

    svc.feed(final("EM", "good morning church", svc.clock));
    assert.equal(svc.lines().length, 1);
    assert.equal(svc.sweepActive, true, "a final is held, so the sweep is armed");

    const broadcastsBefore = broadcasts.length;
    svc.clock += 4 * 60 * 60_000 + 1_000; // just past the horizon
    t.mock.timers.tick(5_000); // one sweep tick is enough — the clock jump did the aging

    try {
      assert.equal(svc.lines().length, 0, "the aged-out final is gone");
      assert.ok(broadcasts.length > broadcastsBefore, "the sweep broadcast once the final went stale");
      const dropLogs = logs.calls
        .map((args) => args[0])
        .filter((a): a is string => typeof a === "string" && a.startsWith("[prodcom] dropped"));
      assert.equal(dropLogs.length, 1, `expected exactly one drop log, got: ${JSON.stringify(dropLogs)}`);
      assert.equal(dropLogs[0], "[prodcom] dropped 1 line(s) older than 4h");
    } finally {
      console.log = original;
    }

    // Guard proof: with pruneStaleFinals()'s filter removed (finals never pruned
    // by age), lines().length stays 1 here instead of 0, and this goes red.
  });

  it("a final 3 hours old stays", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const svc = new TestProdCom();

    svc.feed(final("EM", "still within the window", svc.clock));
    svc.clock += 3 * 60 * 60_000;
    t.mock.timers.tick(5_000);

    const lines = svc.lines();
    assert.equal(lines.length, 1, `expected the 3h-old line to survive, got: ${JSON.stringify(lines)}`);
    assert.equal(lines[0].text, "still within the window");
  });

  it("the sweep is not running once the buffer is empty", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const svc = new TestProdCom();

    assert.equal(svc.sweepActive, false, "nothing to sweep at start-up");

    svc.feed(final("EM", "one line", svc.clock));
    assert.equal(svc.sweepActive, true, "arms once a final is held");

    svc.clock += 4 * 60 * 60_000 + 1_000;
    t.mock.timers.tick(5_000);

    assert.equal(svc.lines().length, 0, "the buffer emptied");
    assert.equal(svc.sweepActive, false, "disarms once both finals and partials are empty");
  });
});
