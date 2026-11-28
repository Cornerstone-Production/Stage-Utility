// The arithmetic behind Needs attention at a size. jsdom has no layout, so this
// is the part of "never over anything else" that a unit test can own: whatever
// fitAttention returns must add up to no more than the box.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLEAR_TOGGLE_MIN_PX, HEADER_PX, MORE_PX, ROW_PX, STRIP_PX, UNMEASURED_ROWS, buttonSize, buttonsFor, fitAttention, roomFor,
} from "./fit.js";

const claimed = (rows: number, count: number, strip: boolean) =>
  HEADER_PX + rows * ROW_PX + (rows < count ? MORE_PX : 0) + (strip ? STRIP_PX : 0);

test("whatever the box, the rows, the count line and the strip never claim more than it", () => {
  for (let h = 1; h <= 600; h++) {
    for (const count of [0, 1, 3, 5, 12]) {
      for (const wantStrip of [true, false]) {
        const f = fitAttention(h, count, wantStrip);
        if (f.rows === 0 && !f.strip) continue; // the header alone is the floor
        assert.ok(claimed(f.rows, count, f.strip) <= h, `h=${h} count=${count}: rows ${f.rows} strip ${f.strip}`);
        assert.ok(!f.strip || wantStrip, "a strip nobody asked for");
      }
    }
  }
});

test("as many whole rows as fit: one more would not", () => {
  for (let h = 100; h <= 600; h += 7) {
    const f = fitAttention(h, 12, true);
    if (f.rows === 0 || f.rows === 12) continue;
    assert.ok(claimed(f.rows + 1, 12, f.strip) > h, `h=${h}: ${f.rows} rows left room for another`);
  }
});

test("the healthy line yields before the list does", () => {
  // 120px: header 32 + a row and its count line is 112, no room for the strip.
  assert.deepEqual(fitAttention(120, 3, true), { rows: 1, strip: false });
  // Tall enough for both.
  assert.deepEqual(fitAttention(260, 3, true), { rows: 3, strip: true });
});

test("a box with room for no row draws the header alone", () => {
  assert.deepEqual(fitAttention(60, 4, true), { rows: 0, strip: false });
});

test("an unmeasured box gets the default rows, never none", () => {
  assert.deepEqual(fitAttention(0, 9, true), { rows: UNMEASURED_ROWS, strip: true });
  assert.deepEqual(fitAttention(0, 2, false), { rows: 2, strip: false });
});

test("buttons by width", () => {
  assert.deepEqual([0, 600, 440, 439, 340, 339, 240, 239].map(buttonsFor), [
    "full", "full", "full", "compact", "compact", "fix", "fix", "none",
  ]);
});

test("wherever the all-clear tile offers Show N snoozed, the list it opens holds a row", () => {
  // The all-clear tile offers the toggle on its height alone, so this is what
  // keeps that height at or above the header and one row.
  for (let h = 1; h <= 600; h++) {
    if (!roomFor(h, CLEAR_TOGGLE_MIN_PX)) continue;
    for (const count of [1, 2, 5, 12]) {
      for (const wantStrip of [true, false]) {
        assert.ok(fitAttention(h, count, wantStrip).rows >= 1, `h=${h} count=${count} strip=${wantStrip}`);
      }
    }
  }
});

test("roomFor: unmeasured shows, then the threshold", () => {
  assert.deepEqual([0, -1, 55, 56, 57].map((h) => roomFor(h, 56)), [true, true, false, true, true]);
});

test("buttons are full size only when both fit at it", () => {
  assert.deepEqual((["full", "compact", "fix", "none"] as const).map(buttonSize), ["medium", "small", "small", "small"]);
});
