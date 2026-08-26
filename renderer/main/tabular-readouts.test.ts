// A number on a wall must not move while you read it.
//
// Proportional digits are different widths, so a clock reflows every second and
// an SPL meter jitters ten times a second — the text physically shifts. Tabular
// figures are all one width, so only the glyphs change.
//
// This reads the source because textStyle is not exported and the decision it
// encodes is a LIST, not behaviour that a render could reveal without a browser.
// It matches on the set's contents, which prose cannot satisfy, and asserts an
// exact membership both ways — a new numeric readout that forgets this fails.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { LAYOUT_OBJECTS } from "./layout-objects.js";

const SRC = readFileSync(new URL("./layout-renderer.tsx", import.meta.url), "utf8");

/** The set as the renderer actually declares it. */
function declared(): string[] {
  const m = SRC.match(/const TABULAR_TYPES = new Set<string>\(\[([\s\S]*?)\]\)/);
  assert.ok(m, "TABULAR_TYPES is gone — the readouts lost their tabular figures");
  return [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
}

/** Content that is a number you watch change. */
const NUMERIC = [
  "clock", "countdown-timer", "pp-timer", "baptism-timer",
  "spl-meter", "people-counter", "service-pacing", "slide-progress", "charger-battery",
];

describe("numeric readouts", () => {
  test("every one of them is tabular", () => {
    assert.deepEqual(declared().sort(), [...NUMERIC].sort());
  });

  test("and the set names only real object types", () => {
    // A typo would silently drop a widget back to proportional digits while the
    // list still claimed otherwise.
    for (const t of declared()) assert.ok(t in LAYOUT_OBJECTS, `${t} is not an object type`);
  });

  test("word readouts are deliberately excluded", () => {
    // Mono makes prose worse, so the status pills and the wireless summaries
    // stay in the sans face. Naming them here stops a later sweep "fixing" it.
    for (const t of ["obs-status", "reaper-status", "record-status", "integration-status", "wireless-summary", "text"]) {
      assert.ok(!declared().includes(t), `${t} should not be tabular`);
    }
  });

  test("the renderer applies both halves, not just one", () => {
    // tabular-nums alone leaves the sans face, whose digits are already
    // proportional in some weights; the mono face alone still lets a font with
    // proportional figures through. Both, or neither is worth doing.
    assert.match(SRC, /css\.fontFamily = "var\(--font-mono\)"/);
    assert.match(SRC, /css\.fontVariantNumeric = "tabular-nums"/);
  });
});
