// Schedules as blocks on a week grid.
//
// The awkward parts of a calendar are arithmetic: a block that started
// yesterday, a block that runs past midnight, two blocks at the same time, a
// drag made upward, and a day that is 23 or 25 hours long. Each of those is a
// test here, because each of them is a picture that looks plausible and is wrong.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageSchedule } from "@main/types/signage";

import { clockOf, dragToTimes, layOutDay, snapMinutes, weekOf } from "./week-layout";

const DAY = 86_400_000;
const MID = 1_787_000_000_000; // an arbitrary local midnight for the arithmetic
const HOUR = 3_600_000;

const sched = (id: string, enabled = true): SignageSchedule => ({
  id,
  name: id,
  enabled,
  groupIds: [],
  playlistId: "p1",
  window: { kind: "always" },
  createdAt: "",
});

const day = (intervals: { schedule: SignageSchedule; from: number; to: number }[]) => ({
  dayStart: MID,
  dayEnd: MID + DAY,
  intervals,
});

describe("placing one block", () => {
  test("sits where its hours are", () => {
    const [b] = layOutDay(day([{ schedule: sched("a"), from: MID + 6 * HOUR, to: MID + 12 * HOUR }]), 2);
    assert.equal(b.day, 2);
    assert.equal(b.top, 0.25);
    assert.equal(b.bottom, 0.5);
    assert.equal(b.continued, false);
  });

  test("carries the UNCLIPPED times, so a wrapped block can print when it really started", () => {
    // top/bottom are clipped to the column. A block printing its times from
    // those would say a Thursday-night slot starts at midnight on Friday.
    const from = MID - 2 * HOUR;
    const to = MID + 2 * HOUR;
    const [b] = layOutDay(day([{ schedule: sched("a"), from, to }]), 0);
    assert.equal(b.from, from);
    assert.equal(b.to, to);
    assert.equal(b.top, 0, "the DRAWING is still clipped");
  });

  test("a block that started YESTERDAY draws from the top, and says so", () => {
    // Thursday 22:00 to Friday 02:00, drawn on the Friday column. Left
    // unclipped this is a negative offset, and the block renders off the grid.
    const [b] = layOutDay(day([{ schedule: sched("a"), from: MID - 2 * HOUR, to: MID + 2 * HOUR }]), 0);
    assert.equal(b.top, 0);
    assert.equal(b.bottom, 1 / 12);
    assert.equal(b.continued, true, "a wrapped block has to be drawn as continuing");
  });

  test("a block running past midnight is clipped at the bottom", () => {
    const [b] = layOutDay(day([{ schedule: sched("a"), from: MID + 22 * HOUR, to: MID + 26 * HOUR }]), 0);
    assert.equal(b.bottom, 1);
  });

  test("a 25-hour day is still a full column", () => {
    // The clocks going back. Dividing by a hard-coded 24h would leave an hour of
    // the column undrawable and every block slightly too high.
    const longDay = { dayStart: MID, dayEnd: MID + DAY + HOUR, intervals: [{ schedule: sched("a"), from: MID, to: MID + DAY + HOUR }] };
    const [b] = layOutDay(longDay, 0);
    assert.equal(b.top, 0);
    assert.equal(b.bottom, 1);
  });
});

describe("two blocks at the same time", () => {
  test("sit side by side", () => {
    const blocks = layOutDay(
      day([
        { schedule: sched("a"), from: MID + 6 * HOUR, to: MID + 12 * HOUR },
        { schedule: sched("b"), from: MID + 8 * HOUR, to: MID + 10 * HOUR },
      ]),
      0,
    );
    assert.deepEqual(blocks.map((b) => b.column), [0, 1]);
    assert.deepEqual(blocks.map((b) => b.columns), [2, 2]);
  });

  test("but blocks that merely touch reuse the column", () => {
    // 09:00-10:00 then 10:00-11:00 is not an overlap. Treating it as one makes
    // a day of back-to-back slots render as a staircase.
    const blocks = layOutDay(
      day([
        { schedule: sched("a"), from: MID + 9 * HOUR, to: MID + 10 * HOUR },
        { schedule: sched("b"), from: MID + 10 * HOUR, to: MID + 11 * HOUR },
      ]),
      0,
    );
    assert.deepEqual(blocks.map((b) => b.column), [0, 0]);
    assert.deepEqual(blocks.map((b) => b.columns), [1, 1]);
  });

  test("the one LOWER in the list is marked as beaten", () => {
    // Order is the priority rule. A calendar drawing both as equal hides the one
    // thing an operator has to be able to predict from looking at it.
    const blocks = layOutDay(
      day([
        { schedule: sched("winner"), from: MID + 6 * HOUR, to: MID + 12 * HOUR },
        { schedule: sched("loser"), from: MID + 8 * HOUR, to: MID + 10 * HOUR },
      ]),
      0,
    );
    assert.equal(blocks.find((b) => b.schedule.id === "winner")?.beatenBy, null);
    assert.equal(blocks.find((b) => b.schedule.id === "loser")?.beatenBy, "winner");
  });

  test("a DISABLED schedule above does not beat anything", () => {
    const blocks = layOutDay(
      day([
        { schedule: sched("off", false), from: MID + 6 * HOUR, to: MID + 12 * HOUR },
        { schedule: sched("on"), from: MID + 8 * HOUR, to: MID + 10 * HOUR },
      ]),
      0,
    );
    assert.equal(blocks.find((b) => b.schedule.id === "on")?.beatenBy, null);
  });

  test("and one that does not overlap in TIME does not beat it either", () => {
    const blocks = layOutDay(
      day([
        { schedule: sched("morning"), from: MID + 6 * HOUR, to: MID + 8 * HOUR },
        { schedule: sched("evening"), from: MID + 18 * HOUR, to: MID + 20 * HOUR },
      ]),
      0,
    );
    assert.equal(blocks.find((b) => b.schedule.id === "evening")?.beatenBy, null);
  });
});

describe("dragging a slot", () => {
  test("snaps to a quarter of an hour", () => {
    // An unsnapped drag produces 09:07-13:52, which nobody wants and everybody
    // then corrects by hand.
    assert.equal(snapMinutes(0.5), 720);
    assert.equal(clockOf(snapMinutes(0.5)), "12:00");
    assert.equal(clockOf(snapMinutes(0.51)), "12:15");
  });

  test("upward is the same range as downward", () => {
    // A calendar that refused one direction feels broken.
    assert.deepEqual(dragToTimes(0.75, 0.25), dragToTimes(0.25, 0.75));
    assert.deepEqual(dragToTimes(0.25, 0.75), { start: "06:00", end: "18:00" });
  });

  test("a click that snapped to nothing becomes the smallest real slot", () => {
    // A zero-length window is one the resolver ignores entirely, so the operator
    // would have drawn a schedule that never plays.
    const t = dragToTimes(0.5, 0.5);
    assert.equal(t.start, "12:00");
    assert.equal(t.end, "12:15");
  });

  test("dragging to the very bottom ends at midnight", () => {
    // 24:00 is not a time. As a window, "00:00" as the end means the end of the
    // day — which is what wrapping already means everywhere else.
    const t = dragToTimes(0.9, 1);
    assert.equal(t.end, "00:00");
    assert.notEqual(t.start, t.end);
  });
});

describe("which seven days are shown", () => {
  const dayStartOf = (ms: number) => Math.floor(ms / DAY) * DAY;
  // MID is a Thursday under this arithmetic; the exact day does not matter, only
  // that the helper walks back to a Sunday and forward seven.
  const weekdayOf = (ms: number) => Math.floor(ms / DAY) % 7;

  test("starts on a Sunday and runs seven days", () => {
    const days = weekOf(MID + 10 * HOUR, dayStartOf, weekdayOf);
    assert.equal(days.length, 7);
    assert.equal(weekdayOf(days[0]), 0);
  });

  test("each day follows the last", () => {
    // Walked a day at a time rather than by adding N×24h: a DST day is 23 or 25
    // hours long, and adding would land in the wrong day that week.
    const days = weekOf(MID, dayStartOf, weekdayOf);
    for (let i = 1; i < days.length; i++) assert.ok(days[i] > days[i - 1]);
  });

  test("anchoring anywhere in a week gives the same week", () => {
    // MID is a Thursday under this arithmetic, so the anchor is moved to the
    // Saturday — the last day of the SAME week. My first version used +3 days,
    // which lands on the Sunday and is a different week; the assertion was
    // wrong, not the code.
    const a = weekOf(MID, dayStartOf, weekdayOf);
    const b = weekOf(MID + 2 * DAY, dayStartOf, weekdayOf);
    assert.equal(weekdayOf(MID), 4, "the fixture is not the day this test assumes");
    assert.deepEqual(a, b);
  });

  test("and the day AFTER that week is a different week", () => {
    // The other side of the same property, so "same week" cannot pass by
    // returning a constant.
    const a = weekOf(MID, dayStartOf, weekdayOf);
    const b = weekOf(MID + 3 * DAY, dayStartOf, weekdayOf);
    assert.notDeepEqual(a, b);
  });
});
