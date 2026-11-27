// The fader's scale: linear in dB from -60 (or the allowlist's minimum) to the top,
// the Core's minimum at the bottom stop. Pure arithmetic; the thumb that draws it is
// checked in a browser.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { FADER_FLOOR_DB, TICK_MARKS_DB, atBottom, faderScale, stepFrom, travelOf, valueAt } from "./fader-scale.js";

const GAIN = { min: -100, max: 20 };

test("-60 dB to the allowlist's maximum, the Core's minimum at the bottom stop", () => {
  assert.deepEqual(faderScale(GAIN, { min: -100, max: 12 }), { bottom: -100, floor: -60, top: 12 });
  assert.deepEqual(faderScale(GAIN, { min: null, max: null }), { bottom: -100, floor: -60, top: 20 }, "no limits: the Core's range");
  assert.deepEqual(faderScale(GAIN, { min: -40, max: 0 }), { bottom: -40, floor: -40, top: 0 }, "a higher allowlist minimum is the floor");
  assert.equal(FADER_FLOOR_DB, -60);
  assert.equal(faderScale(null, { min: null, max: null }), null);
});

test("travel is linear in dB above the floor; below it everything sits at the bottom stop", () => {
  const s = faderScale(GAIN, { min: -100, max: 12 })!;
  assert.equal(travelOf(s, 12), 1);
  assert.equal(travelOf(s, -60), 0);
  assert.equal(travelOf(s, -80), 0);
  assert.equal(travelOf(s, -24), 0.5, "-24 is halfway on -60..+12");
  assert.equal(valueAt(s, 0), -100, "the bottom stop writes the Core's minimum");
  assert.equal(valueAt(s, 0.5), -24);
  assert.equal(valueAt(s, 1), 12);
  for (const v of [-55, -30, 0, 6]) assert.ok(Math.abs(valueAt(s, travelOf(s, v)) - v) < 1e-9, `${v} does not round-trip`);
  assert.ok(atBottom(s, -100));
  assert.ok(!atBottom(s, -60));
});

test("the tick marks fall evenly on the scale", () => {
  const s = faderScale(GAIN, { min: -100, max: 12 })!;
  const at = TICK_MARKS_DB.filter((t) => t >= s.floor && t <= s.top).map((t) => travelOf(s, t));
  assert.equal(at.length, 7);
  for (let i = 1; i < at.length; i++) assert.ok(Math.abs(at[i - 1] - at[i] - 1 / 6) < 1e-9, `marks ${i - 1} and ${i} are not 1/6 apart`);
});

test("a step stays on the scale: up from below the floor goes to the floor, down from the floor to the bottom", () => {
  const s = faderScale(GAIN, { min: -100, max: 0 })!;
  assert.equal(stepFrom(s, -20, 1, 3), -17);
  assert.equal(stepFrom(s, -1, 1, 3), 0);
  assert.equal(stepFrom(s, -100, 1, 3), -60);
  assert.equal(stepFrom(s, -58, -1, 3), -60);
  assert.equal(stepFrom(s, -60, -1, 3), -100);
});

test("a top at or under -60 dB still leaves a fader: the linear part starts 12 dB under it", () => {
  const s = faderScale(GAIN, { min: -100, max: -70 })!;
  assert.deepEqual(s, { bottom: -100, floor: -82, top: -70 });
  assert.equal(travelOf(s, -76), 0.5);
  const tight = faderScale(GAIN, { min: -75, max: -70 })!;
  assert.equal(tight.floor, -75, "never under the bottom");
  assert.ok(travelOf(tight, -72.5) > 0 && travelOf(tight, -72.5) < 1);
});
