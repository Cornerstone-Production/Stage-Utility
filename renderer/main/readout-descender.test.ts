// The value line must have room for a descender.
//
// Measured in Chrome on 2026-09-06 against the real fonts: at a 107px value,
// IBM Plex's "g" reaches 22.6px below the baseline, and a 1.05 line box left
// 15.9px there — 6.6px of every g, y, p and q was cut off by the wrapper's
// overflow: hidden, visible on the Home Recording card as a clipped "g". At 1.2
// the same box leaves 22.4px, and the glyph fits with a hair to spare.
//
// jsdom lays out no glyphs, so this cannot measure. It pins the constant that
// was measured, with the arithmetic that justifies it, so a future "tighten the
// leading" reads this before it repeats the bug. Plex's descender is ~0.21em;
// the room below the baseline at leading L is roughly (L − 0.93) / 2 + 0.22 em
// for this face, which crosses 0.21em just under 1.19.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { VALUE_LEADING } from "./readout-size.js";

test("the value leading leaves room for a descender", () => {
  assert.ok(
    VALUE_LEADING >= 1.19,
    `VALUE_LEADING is ${VALUE_LEADING}; below 1.19 a Plex "g" is clipped by the value wrapper (measured: 1.05 cut 6.6px at 107px)`,
  );
});
