// The capsule's state reading: a triangle and a number for a half-inning, and
// the original string for everything else.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { halfInning, halfInningLabel } from "./score-capsule-state.js";

describe("a baseball half-inning becomes a direction and a number", () => {
  // Every form ESPN was observed serving on a live MLB scoreboard, plus the
  // ordinals it uses for the low innings.
  const cases: [string, "top" | "bottom", string][] = [
    ["Top 1st", "top", "1"],
    ["Top 2nd", "top", "2"],
    ["Top 3rd", "top", "3"],
    ["Top 6th", "top", "6"],
    ["Top 7th", "top", "7"],
    ["Bot 4th", "bottom", "4"],
    ["Bot 5th", "bottom", "5"],
    ["Bot 8th", "bottom", "8"],
    ["Bot 9th", "bottom", "9"],
    // The breaks either side of a half point at the half just played.
    ["Mid 4th", "top", "4"],
    ["End 6th", "bottom", "6"],
    // Extra innings run past the ordinals that have their own word.
    ["Top 11th", "top", "11"],
    ["Bot 12th", "bottom", "12"],
  ];

  for (const [input, half, inning] of cases) {
    it(`${input} reads as ${half} ${inning}`, () => {
      assert.deepEqual(halfInning(input), { half, inning });
    });
  }

  it("the ordinal is dropped, never kept", () => {
    for (const [input] of cases) {
      const got = halfInning(input);
      assert.ok(got, input);
      assert.doesNotMatch(
        got.inning,
        /st|nd|rd|th/,
        `${input} kept its ordinal — the capsule has no room for two more glyphs per game`,
      );
    }
  });
});

describe("everything else keeps its own string", () => {
  // Compressing these would be worse than leaving them: "2nd Quarter" as a
  // triangle and a 2 reads as a down, and a start time is not a period at all.
  const passthrough = [
    "2nd Quarter",
    "1st Half",
    "Q3 5:23",
    "8/31 - 9:38 PM EDT",
    "Final",
    "Final/10",
    "Delayed",
    "Postponed",
    "Halftime",
    "OT",
    "45'+2",
  ];

  for (const input of passthrough) {
    it(`${input} is not a half-inning`, () => {
      assert.equal(halfInning(input), null);
    });
  }

  it("a bare number is not a half-inning either", () => {
    assert.equal(halfInning("9th"), null);
    assert.equal(halfInning("9"), null);
  });
});

describe("what a screen reader hears", () => {
  // The triangle is aria-hidden and the number has lost its ordinal, so between
  // them the capsule says "9". This is the phrase that replaces it.
  const spoken: [string, string][] = [
    ["Top 1st", "Top of the 1st"],
    ["Bot 2nd", "Bottom of the 2nd"],
    ["Top 3rd", "Top of the 3rd"],
    ["Bot 9th", "Bottom of the 9th"],
    ["Mid 4th", "Top of the 4th"],
    ["End 6th", "Bottom of the 6th"],
    // The teens take "th" whatever their last digit says — 11th, not 11st.
    ["Top 11th", "Top of the 11th"],
    ["Bot 12th", "Bottom of the 12th"],
    ["Top 13th", "Top of the 13th"],
    ["Bot 21st", "Bottom of the 21st"],
  ];

  for (const [input, said] of spoken) {
    it(`${input} is read as "${said}"`, () => {
      const h = halfInning(input);
      assert.ok(h, input);
      assert.equal(halfInningLabel(h), said);
    });
  }
});
