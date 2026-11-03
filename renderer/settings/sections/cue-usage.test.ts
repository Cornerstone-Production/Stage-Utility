// cue-usage.test.ts — which names a command is looked up by.
//
// ONE list of names serves the row's Used on chips and the rule editor's places, so the
// two cannot disagree. A pair is the case that did: its dialog looked up the base and the
// two half names, and its row also looked up each half's former names, so a Button on an
// old half name showed on the row and not in the dialog.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { namesFor } from "./cue-usage.js";

const rule = (params: Record<string, string | number>) => ({ trigger: { params } });

describe("namesFor", () => {
  test("a single command is its own name and its former names", () => {
    assert.deepEqual(namesFor({ rule: rule({ name: "take_screens", aliases: "old_a, old_b" }) }), ["take_screens", "old_a", "old_b"]);
    assert.deepEqual(namesFor({ rule: rule({ name: "take_screens" }) }), ["take_screens"]);
  });

  test("a pair is its base, both halves' names and both halves' former names", () => {
    const names = namesFor({
      pair: {
        base: "projectors",
        onName: "projectors_on",
        offName: "projectors_off",
        on: rule({ name: "projectors_on", aliases: "beamers_on" }),
        off: rule({ name: "projectors_off", aliases: "beamers_off" }),
      },
    });
    assert.deepEqual(names, ["projectors", "projectors_on", "projectors_off", "beamers_on", "beamers_off"]);
  });
});
