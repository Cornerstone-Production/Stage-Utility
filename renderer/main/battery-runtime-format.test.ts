// How a pack's remaining runtime is written and coloured.
//
// Two decisions worth pinning, because both are easy to "tidy" into something
// that reads worse on a wall:
//
//   - the hour is ALWAYS printed, so a column of packs stays a column and 0:45
//     cannot be misread as 45 hours;
//   - the thresholds are a SERVICE, not a percentage. 90 minutes covers a
//     service with margin, an hour covers one already under way, and under half
//     an hour is a pack somebody has to go and swap. A battery percentage cannot
//     express this — the same 60% is three hours on one pack and forty minutes
//     on another, which is the whole reason runtime is shown at all.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { runtimeColor, runtimeText } from "./layout-renderer.js";

describe("runtime remaining reads as H:MM", () => {
  test("keeps the hour under an hour", () => {
    assert.equal(runtimeText(45), "0:45");
    assert.equal(runtimeText(5), "0:05");
  });

  test("and pads the minutes past it", () => {
    assert.equal(runtimeText(215), "3:35");
    assert.equal(runtimeText(60), "1:00");
    assert.equal(runtimeText(369), "6:09");
  });

  test("a flat battery is 0:00, not a dash", () => {
    // Zero minutes left is a reading, and a very loud one. A dash would say the
    // receiver is not reporting, which is a different thing entirely.
    assert.equal(runtimeText(0), "0:00");
  });

  test("no reading is null, so the widget can draw a dash", () => {
    assert.equal(runtimeText(null), null);
    assert.equal(runtimeText(undefined), null);
    assert.equal(runtimeText(Number.NaN), null);
    assert.equal(runtimeText(-1), null);
  });
});

describe("runtime is coloured against a service", () => {
  test("green with a service in hand", () => {
    assert.equal(runtimeColor(215), "var(--green-10)");
    assert.equal(runtimeColor(90), "var(--green-10)");
  });

  test("amber once it would only just make it", () => {
    assert.equal(runtimeColor(89), "var(--yellow-10)");
    assert.equal(runtimeColor(30), "var(--yellow-10)");
  });

  test("red when somebody has to go and swap it", () => {
    assert.equal(runtimeColor(29), "var(--red-10)");
    assert.equal(runtimeColor(0), "var(--red-10)");
  });

  test("no reading takes no colour, rather than reading as flat", () => {
    assert.equal(runtimeColor(null), null);
  });
});
