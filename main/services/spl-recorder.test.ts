// A plan item running a SECOND time must get its own SPL entry.
//
// The incident (18 Sep 2026): two services on one plan merged into a single
// record, and every recorder matched items by itemId alone. The timeline
// recorder's copy of that bug was fixed in 1.20.1 (see
// service-timeline-recorder.test.ts); this is the same bug in the SPL recorder,
// where the consequence is a peak and an Leq that mix two services' levels — the
// second service's quiet doors item folded into the first service's, so neither
// row read as what actually happened.
//
// Driven directly against recordSample/finalizePrevItem (private, reached via a
// cast) rather than through onLiveTick: what is under test is the open-or-new
// decision, not the transition machinery around it, which recorder-forget.test.ts
// covers. Sampling through onLiveTick would need a live Smaart meter.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-spl-rerun-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { splRecorder } = await import("./spl-recorder.js");

type Metrics = Record<string, { max: number | null; avg: number | null; leq?: number | null; count: number }>;
type Item = {
  itemId: string;
  title: string;
  itemType?: string | null;
  sequence: number;
  metrics: Metrics;
  maxSpl: number | null;
  leqSpl?: number | null;
  sampleCount: number;
  startedAt: string;
  endedAt: string | null;
};
type Rec = {
  serviceKey: string;
  serviceDate: string;
  meterId: string | null;
  metricKey: string | null;
  startedAt: string;
  endedAt: string | null;
  items: Item[];
};
type Held = {
  current: Rec | null;
  currentKey: string | null;
  lastItemId: string | null;
  nextSequence: number;
  recordSample(
    itemId: string,
    title: string | null,
    itemType: string | null,
    sample: { meterId: string; metrics: Record<string, number> } | null,
  ): void;
  finalizePrevItem(): void;
};

const METRIC = "SPL A Slow";
function meter(v: number) {
  return { meterId: "m1", metrics: { [METRIC]: v } };
}

describe("spl-recorder: a re-run item gets its own entry", () => {
  const rec = splRecorder as unknown as Held;
  const RECORD_STARTED_AT = "2026-09-18T23:23:46.000Z";

  /** The first run of Doors, closed — as the first service left it. */
  function firstRun(endedAt: string | null): Item {
    return {
      itemId: "doors",
      title: "Doors",
      itemType: "item",
      sequence: 0,
      metrics: { [METRIC]: { max: 104, avg: null, leq: 101, count: 40 } },
      maxSpl: 104,
      leqSpl: 101,
      sampleCount: 40,
      startedAt: RECORD_STARTED_AT,
      endedAt,
    };
  }

  beforeEach(() => {
    rec.current = {
      serviceKey: "st1:plan:occ-1",
      serviceDate: "2026-09-18",
      meterId: "m1",
      metricKey: METRIC,
      startedAt: RECORD_STARTED_AT,
      endedAt: null,
      items: [],
    };
    // No archive writes from these samples: recordSpl is keyed off currentKey.
    rec.currentKey = null;
    rec.nextSequence = 1;
    rec.lastItemId = null;
  });

  it("starts a second entry when the same item goes live again long after its last run", () => {
    // The first run closed an hour and a half ago — the second service's Doors.
    const longAgo = new Date(Date.now() - 90 * 60_000).toISOString();
    rec.current!.items = [firstRun(longAgo)];

    rec.recordSample("doors", "Doors", "item", meter(78));

    assert.equal(rec.current!.items.length, 2, "the re-run folded its samples into the finished first run");
    const [first, second] = rec.current!.items as [Item, Item];
    // The guard: without lastItemEntry/isStepBackTo, `first` would hold both
    // services — count 41 including a 78 dB sample — and there would be no
    // second entry at all.
    assert.equal(first.metrics[METRIC]!.max, 104, "the first run's max was rewritten");
    assert.equal(first.metrics[METRIC]!.leq, 101, "the first run's Leq was rewritten");
    assert.equal(first.metrics[METRIC]!.count, 40, "the second service's sample landed in the first run");
    assert.equal(first.endedAt, longAgo, "the first run was reopened");

    assert.equal(second.itemId, "doors");
    assert.equal(second.sequence, 1);
    assert.equal(second.endedAt, null);
    assert.equal(second.metrics[METRIC]!.max, 78, "the re-run's own max");
    assert.equal(second.metrics[METRIC]!.count, 1);
  });

  it("keeps the two entries separate over a whole second run", () => {
    rec.current!.items = [firstRun(new Date(Date.now() - 90 * 60_000).toISOString())];
    for (const v of [70, 82, 75]) rec.recordSample("doors", "Doors", "item", meter(v));

    assert.equal(rec.current!.items.length, 2, "a later sample started a third entry");
    const second = rec.current!.items[1]!;
    assert.equal(second.metrics[METRIC]!.max, 82);
    assert.equal(second.metrics[METRIC]!.count, 3);
    assert.equal(rec.current!.items[0]!.metrics[METRIC]!.count, 40);
  });

  it("reopens the entry on a step back within the same-service gap", () => {
    const fiftySecondsAgo = new Date(Date.now() - 50_000).toISOString();
    rec.current!.items = [firstRun(fiftySecondsAgo)];

    rec.recordSample("doors", "Doors", "item", meter(99));

    assert.equal(rec.current!.items.length, 1, "a step back started a duplicate entry");
    const only = rec.current!.items[0]!;
    assert.equal(only.startedAt, RECORD_STARTED_AT, "a reopen must keep the original start");
    assert.equal(only.endedAt, null, "a reopened entry must be open again for finalizePrevItem to close");
    assert.equal(only.metrics[METRIC]!.count, 41, "the step back's sample belongs to the same run");
  });

  it("reopens an entry that was never closed, rather than duplicating it", () => {
    rec.current!.items = [firstRun(null)];
    rec.recordSample("doors", "Doors", "item", meter(90));
    assert.equal(rec.current!.items.length, 1, "an open entry was duplicated");
  });

  it("finalizePrevItem closes the LAST run of an id, not the first", () => {
    const longAgo = new Date(Date.now() - 90 * 60_000).toISOString();
    rec.current!.items = [firstRun(longAgo)];
    rec.recordSample("doors", "Doors", "item", meter(78));
    rec.lastItemId = "doors";
    rec.finalizePrevItem();

    const [first, second] = rec.current!.items as [Item, Item];
    assert.equal(first.endedAt, longAgo, "the finished first run was re-closed");
    assert.ok(second.endedAt, "the live run was left open forever");
  });
});
