// lane.test.ts — the item lane's two things that have a wrong answer: what a
// block is allowed to say, and where it sits.
//
// No DOM. The label rule takes its measurer as an argument precisely so this can
// be arithmetic: jsdom has no canvas 2d context, so a test that used the real
// measurer would exercise the fallback estimate and prove nothing about the rule.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { LANE_LABEL_PADDING, MAX_EXTRA_LANES, laneLabel, laneSegments, segmentAt, type LaneItem } from "./lane.js";

/** A deterministic measurer: 6px per character, like a condensed 11px mono. */
const measure = (s: string) => s.length * 6;

function item(over: Partial<LaneItem> = {}): LaneItem {
  return {
    itemId: "i1",
    title: "Welcome & Announcements",
    sequence: 4,
    startedAt: "2026-09-17T20:15:00.000Z",
    endedAt: "2026-09-17T20:20:00.000Z",
    preService: false,
    plannedSec: 300,
    actualSec: 300,
    ...over,
  };
}

describe("laneLabel", () => {
  test("the full title when it fits with the padding to spare", () => {
    const it = item({ title: "Message" }); // 7 chars → 42px + 12 = 54
    assert.deepEqual(laneLabel(it, 54, measure), { kind: "title", text: "Message" });
  });

  test("the rundown number when the title does not fit", () => {
    const it = item({ title: "Message", sequence: 4 });
    // One pixel short of the title's requirement, plenty for "5" (6 + 12 = 18).
    assert.deepEqual(laneLabel(it, 53, measure), { kind: "number", text: "5" });
  });

  test("the number is the rundown number, not the array index", () => {
    // The table's first column prints sequence + 1. A lane that printed the
    // sequence would name a different row of the same table.
    assert.equal(laneLabel(item({ title: "x".repeat(40), sequence: 11 }), 30, measure).text, "12");
  });

  test("nothing at all when even the number does not fit", () => {
    assert.deepEqual(laneLabel(item({ title: "Message" }), 17, measure), { kind: "none", text: "" });
  });

  test("never a clipped or ellipsised title", () => {
    // Sweep every width from 0 to well past the title: the text must always be
    // the WHOLE title, the whole number, or empty. This is the bug the rule
    // exists for — "Welcome & Announ…" reads as an item that is not in the plan.
    const it = item({ title: "Welcome & Announcements", sequence: 4 });
    const legal = new Set([it.title, "5", ""]);
    for (let w = 0; w <= 220; w++) {
      const label = laneLabel(it, w, measure);
      assert.ok(legal.has(label.text), `width ${w} produced ${JSON.stringify(label.text)}`);
      assert.ok(!label.text.includes("…"), `width ${w} ellipsised`);
    }
  });

  test("an untitled item falls straight to its number", () => {
    assert.deepEqual(laneLabel(item({ title: "   ", sequence: 0 }), 200, measure), { kind: "number", text: "1" });
  });

  test("the padding is a real requirement, not a rounding allowance", () => {
    const it = item({ title: "Song" }); // 24px
    assert.equal(laneLabel(it, 24 + LANE_LABEL_PADDING, measure).kind, "title");
    assert.equal(laneLabel(it, 24 + LANE_LABEL_PADDING - 1, measure).kind, "number");
  });
});

describe("laneSegments", () => {
  const t0 = Date.parse("2026-09-17T20:00:00.000Z");
  const t1 = Date.parse("2026-09-17T21:00:00.000Z");
  const opts = { domainStartMs: t0, domainEndMs: t1, liveEdgeMs: t1, plotX0: 40, plotX1: 640 };

  test("a segment's x span is its window on the scale", () => {
    // 20:15 → 20:30 of a 20:00–21:00 domain is a quarter to a half of a 600px
    // plot: 40 + 150 = 190 to 40 + 300 = 340.
    const [seg] = laneSegments(
      [item({ startedAt: "2026-09-17T20:15:00.000Z", endedAt: "2026-09-17T20:30:00.000Z" })],
      opts,
    );
    assert.equal(seg.x0, 190);
    assert.equal(seg.x1, 340);
    assert.equal(seg.visible, true);
  });

  test("pre-service items take the upper row", () => {
    const segs = laneSegments([item({ preService: true }), item({ itemId: "i2", preService: false })], opts);
    assert.deepEqual(segs.map((s) => s.row), ["pre", "service"]);
  });

  test("a live item runs to the live edge, not to zero width", () => {
    const live = Date.parse("2026-09-17T20:45:00.000Z");
    const [seg] = laneSegments(
      [item({ startedAt: "2026-09-17T20:30:00.000Z", endedAt: null })],
      { ...opts, liveEdgeMs: live },
    );
    assert.equal(seg.x0, 340);
    assert.equal(seg.x1, 490);
  });

  test("an item running past the domain is clipped to the plot, not drawn outside it", () => {
    const [seg] = laneSegments(
      [item({ startedAt: "2026-09-17T20:50:00.000Z", endedAt: "2026-09-17T21:30:00.000Z" })],
      opts,
    );
    assert.equal(seg.x1, 640);
    assert.equal(seg.visible, true);
  });

  test("an item entirely before the domain is not visible", () => {
    const [seg] = laneSegments(
      [item({ startedAt: "2026-09-17T19:00:00.000Z", endedAt: "2026-09-17T19:30:00.000Z" })],
      opts,
    );
    assert.equal(seg.visible, false);
  });

  test("an unparseable start is dropped rather than placed at the epoch", () => {
    assert.equal(laneSegments([item({ startedAt: "not a date" })], opts).length, 0);
  });
});

describe("segmentAt", () => {
  const t0 = Date.parse("2026-09-17T20:00:00.000Z");
  const t1 = Date.parse("2026-09-17T21:00:00.000Z");
  const opts = { domainStartMs: t0, domainEndMs: t1, liveEdgeMs: t1, plotX0: 40, plotX1: 640 };
  const segs = laneSegments(
    [
      item({ itemId: "a", sequence: 0, startedAt: "2026-09-17T20:00:00.000Z", endedAt: "2026-09-17T20:30:00.000Z" }),
      item({ itemId: "b", sequence: 1, startedAt: "2026-09-17T20:30:00.000Z", endedAt: "2026-09-17T21:00:00.000Z" }),
    ],
    opts,
  );

  test("finds the block under a plot x", () => {
    assert.equal(segmentAt(segs, 100, "service")?.item.itemId, "a");
    assert.equal(segmentAt(segs, 500, "service")?.item.itemId, "b");
  });

  test("at a shared boundary the LATER item wins", () => {
    assert.equal(segmentAt(segs, 340, "service")?.item.itemId, "b");
  });

  test("the other row is never hit", () => {
    assert.equal(segmentAt(segs, 100, "pre"), null);
  });
});

describe("overlapping items", () => {
  const t0 = Date.parse("2026-09-17T19:50:00.000Z");
  const t1 = Date.parse("2026-09-17T21:30:00.000Z");
  const opts = { domainStartMs: t0, domainEndMs: t1, liveEdgeMs: t1, plotX0: 40, plotX1: 640 };

  /** The real shape on the 17 Sep record: "10 min Warning" opens before "Doors"
   *  has closed, and "VIDEO: Pre-roll" before that one has. */
  const overlapping: LaneItem[] = [
    { itemId: "doors", title: "Doors", sequence: 0, startedAt: "2026-09-17T19:50:00.000Z", endedAt: "2026-09-17T20:16:00.000Z", preService: false, plannedSec: null, actualSec: null },
    { itemId: "warn", title: "10 min Warning", sequence: 1, startedAt: "2026-09-17T20:06:00.000Z", endedAt: "2026-09-17T20:16:00.000Z", preService: false, plannedSec: null, actualSec: null },
    { itemId: "preroll", title: "VIDEO: Pre-roll", sequence: 2, startedAt: "2026-09-17T20:07:00.000Z", endedAt: "2026-09-17T20:18:00.000Z", preService: false, plannedSec: null, actualSec: null },
  ];

  test("an overlapping block moves down a lane instead of hiding under one", () => {
    // Drawn on one line, the block underneath is invisible, unlabelled and
    // unreachable — and it is the one the operator is looking for, because an
    // overlap is what went wrong.
    const segs = laneSegments(overlapping, opts);
    assert.deepEqual(segs.map((s) => s.lane), [0, 1, 2]);
  });

  test("a lane is reused once its last block has finished", () => {
    const sequential: LaneItem[] = [
      { ...overlapping[0], itemId: "a", startedAt: "2026-09-17T19:50:00.000Z", endedAt: "2026-09-17T20:00:00.000Z" },
      { ...overlapping[0], itemId: "b", startedAt: "2026-09-17T20:00:00.000Z", endedAt: "2026-09-17T20:10:00.000Z" },
      { ...overlapping[0], itemId: "c", startedAt: "2026-09-17T20:10:00.000Z", endedAt: "2026-09-17T20:20:00.000Z" },
    ];
    // A normal service is ONE line. Stacking abutting items would put a lane
    // under every block on every service ever recorded.
    assert.deepEqual(laneSegments(sequential, opts).map((s) => s.lane), [0, 0, 0]);
  });

  test("lanes are compared on the millisecond, not the rounded pixel", () => {
    // Two items a second apart round to the same x on an hour-wide plot.
    const tight: LaneItem[] = [
      { ...overlapping[0], itemId: "a", startedAt: "2026-09-17T20:00:00.000Z", endedAt: "2026-09-17T20:00:01.000Z" },
      { ...overlapping[0], itemId: "b", startedAt: "2026-09-17T20:00:01.000Z", endedAt: "2026-09-17T20:10:00.000Z" },
    ];
    assert.deepEqual(laneSegments(tight, opts).map((s) => s.lane), [0, 0]);
  });

  test("the stack stops growing at the cap", () => {
    const many: LaneItem[] = Array.from({ length: 6 }, (_, i) => ({
      ...overlapping[0],
      itemId: `i${i}`,
      sequence: i,
      startedAt: `2026-09-17T20:0${i}:00.000Z`,
      endedAt: "2026-09-17T21:00:00.000Z",
    }));
    const lanes = laneSegments(many, opts).map((s) => s.lane);
    assert.equal(Math.max(...lanes), MAX_EXTRA_LANES);
  });

  test("the pre row stacks independently of the service row", () => {
    const mixed: LaneItem[] = [
      { ...overlapping[0], itemId: "p1", preService: true, startedAt: "2026-09-17T19:50:00.000Z", endedAt: "2026-09-17T20:10:00.000Z" },
      { ...overlapping[0], itemId: "s1", preService: false, startedAt: "2026-09-17T19:55:00.000Z", endedAt: "2026-09-17T20:20:00.000Z" },
    ];
    assert.deepEqual(laneSegments(mixed, opts).map((s) => s.lane), [0, 0]);
  });

  test("hover returns the TOPMOST block, not whichever came last", () => {
    // At 20:10 all three overlap. The one the pointer is actually over is the
    // one in lane 0.
    const segs = laneSegments(overlapping, opts);
    const x = segs[0].x0 + (segs[0].x1 - segs[0].x0) * 0.8;
    assert.equal(segmentAt(segs, x, "service")?.item.itemId, "doors");
  });
});
