// A number with nothing to say what it is.
//
// A bare 0:04:12 on a wall does not tell you what it is counting to, and the
// person who built the layout is not the one reading it on Sunday morning. Six
// readouts now arrive with a caption above the value.
//
// The property that matters most is the one about NOT changing anything: a
// caption is a default on new objects, so no layout anybody already built grows
// a line it did not ask for.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { LAYOUT_OBJECTS } from "./layout-objects.js";

const CAPTIONED = [
  "countdown-timer", "service-pacing", "pp-timer",
  "spl-meter", "people-counter", "baptism-timer",
] as const;

const configOf = (t: string) => LAYOUT_OBJECTS[t as keyof typeof LAYOUT_OBJECTS].config() as Record<string, unknown>;

describe("captions on new readouts", () => {
  test("each of the six arrives with one", () => {
    for (const t of CAPTIONED) {
      const cap = configOf(t).caption;
      assert.equal(typeof cap, "string", `${t} has no caption`);
      assert.ok((cap as string).length > 0, `${t}'s caption is empty`);
    }
  });

  test("nothing else gained one", () => {
    // A caption on a status pill or a lyric line would be noise. An exact set,
    // so a later sweep cannot quietly caption everything.
    const withCaption = Object.keys(LAYOUT_OBJECTS).filter((t) => "caption" in configOf(t));
    assert.deepEqual(withCaption.sort(), [...CAPTIONED].sort());
  });

  test("no caption repeats the widget's own name", () => {
    // "PCO countdown / PCO COUNTDOWN" teaches nothing. The caption says what the
    // NUMBER is, which is a different sentence from what the widget is called.
    for (const t of CAPTIONED) {
      const cap = String(configOf(t).caption).toLowerCase();
      assert.notEqual(cap, LAYOUT_OBJECTS[t].label.toLowerCase(), `${t}'s caption just repeats its label`);
    }
  });
});

describe("existing layouts", () => {
  test("the renderer reads the caption off the object, never a per-type default", () => {
    // THE guard. If the renderer fell back to a built-in string when an object
    // had no caption, every countdown on every existing stage display would
    // sprout one on upgrade. It must read the stored value and nothing else.
    const src = readFileSync(new URL("./layout-renderer.tsx", import.meta.url), "utf8");
    const read = src.match(/const caption = \(o\.config as \{ caption\?: string \| null \}\)\.caption;/);
    assert.ok(read, "ObjectContent no longer reads the caption straight off the object");
    // An `??` on that line would be the fallback this test exists to forbid.
    assert.doesNotMatch(
      src,
      /const caption = \(o\.config as \{ caption\?: string \| null \}\)\.caption\s*\?\?/,
      "the caption falls back to a default — existing objects would gain one",
    );
  });

  // "an object with no caption renders no caption" used to live here as a match
  // on the renderer's source text. It is now readout-caption.test.tsx, which
  // RENDERS the component and reads the result — a source-text guard passes on
  // any rewrite that keeps the words and fails on any that changes them, which
  // is the opposite of what it was for. This one broke on a rewrite that
  // preserved the behaviour exactly.
});
