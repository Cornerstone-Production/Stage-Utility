// The winning marker, and the gap it used to fall into.
//
// Reported as "when changing the schedule order, the green outline is delayed in
// showing up after reordering". Measured in a browser: the marker did not lag,
// it VANISHED for about 300ms and then came back on the right row.
//
// The reorder makes the server rebuild the horizon starting at its own now. The
// board's clock ticks once a second, so until the next tick `at` is behind the
// new horizon's first entry, nothing matches, and the marker has nothing to
// mark. A display must never paper over that — it would show stale content
// believing it current — but a board sitting beside the server should.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageHorizon } from "@main/types/signage";

import { boardEntry, winningOutputsFor, winningScheduleIds } from "./board-entry";

const REBUILT_AT = 1_787_446_050_000;

/** What the server hands back the instant after a reorder. */
const horizon = (scheduleId: string, from = REBUILT_AT): SignageHorizon => [
  { from, until: from + 3_600_000, reason: "schedule", reasonLabel: scheduleId, reasonId: scheduleId },
];

describe("the board's idea of what is playing", () => {
  test("a clock a moment behind the rebuild still finds the entry", () => {
    // 400ms behind, which is the case that blanked the marker.
    const e = boardEntry(horizon("s1"), REBUILT_AT - 400);
    assert.equal(e?.reasonId, "s1", "the marker had nothing to mark");
  });

  test("a whole second behind, which is one tick of the board's clock", () => {
    assert.equal(boardEntry(horizon("s1"), REBUILT_AT - 1000)?.reasonId, "s1");
  });

  test("but past the end of the horizon it still says nothing", () => {
    // The other half. A plan that has genuinely run out must not be reported as
    // current — that is a board confidently describing content nobody is showing.
    assert.equal(boardEntry(horizon("s1"), REBUILT_AT + 3_600_001), null);
  });

  test("an empty horizon is nothing, not a crash", () => {
    assert.equal(boardEntry([], REBUILT_AT), null);
  });

  test("picks the right entry in the middle of a multi-entry horizon", () => {
    const h: SignageHorizon = [
      { from: REBUILT_AT, until: REBUILT_AT + 1000, reason: "schedule", reasonLabel: "a", reasonId: "a" },
      { from: REBUILT_AT + 1000, until: REBUILT_AT + 2000, reason: "schedule", reasonLabel: "b", reasonId: "b" },
    ];
    assert.equal(boardEntry(h, REBUILT_AT + 1500)?.reasonId, "b");
  });
});

describe("several schedules winning at once", () => {
  // Henry asked directly: "would i see more than one green outline if I have
  // more schedules for different groups of displays?" Yes — and it has to be
  // yes, because both really are winning.
  const horizons = {
    "display-9": horizon("weekend"),
    "display-10": horizon("weekend"),
    "display-11": horizon("youth"),
  };

  test("marks every schedule that is winning somewhere", () => {
    assert.deepEqual([...winningScheduleIds(horizons, REBUILT_AT)].sort(), ["weekend", "youth"]);
  });

  test("and can name the screens each one is winning on", () => {
    assert.deepEqual(winningOutputsFor(horizons, REBUILT_AT, "weekend"), ["display-9", "display-10"]);
    assert.deepEqual(winningOutputsFor(horizons, REBUILT_AT, "youth"), ["display-11"]);
  });

  test("a schedule winning nowhere is not marked", () => {
    assert.equal(winningScheduleIds(horizons, REBUILT_AT).has("christmas"), false);
  });

  test("a group default winning is not a schedule winning", () => {
    // reason "default" carries the GROUP's id in reasonId. Marking it would put
    // the green outline on whatever schedule happened to share that id.
    const defaults: Record<string, SignageHorizon> = {
      "display-9": [
        { from: REBUILT_AT, until: REBUILT_AT + 1000, reason: "default", reasonLabel: "Foyer", reasonId: "gr-1" },
      ],
    };
    assert.equal(winningScheduleIds(defaults, REBUILT_AT).size, 0);
  });
});
