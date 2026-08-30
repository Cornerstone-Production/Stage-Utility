// A caption names the box. It does not report anything, so it reads the same
// whatever the box is doing.
//
// `dim` was an opacity on the whole composition, so it took the caption with it
// — and a row of status widgets ended up with two caption strengths: the dimmed
// ones at 45% of the muted token, and the ones in an ACTIVE state (an ERROR, a
// recording) at full. "REAPER" beside "REAPER" in two different greys.
//
// Dim belongs to the READING: the value, and the sub-line under it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SRC = readFileSync(new URL("./readout.tsx", import.meta.url), "utf8");

/** The source with full-line comments removed, so prose cannot satisfy a check.
 *  A comment naming the thing that was taken out is a shape this repo has been
 *  caught by before. */
const CODE = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

/** The style object of the outer composition — everything up to the fill. */
function blockStyle(): string {
  const i = CODE.indexOf('justifyContent: "var(--readout-v-align');
  assert.ok(i >= 0, "the composition's style block moved");
  return CODE.slice(i, CODE.indexOf("}}", i));
}

describe("the caption", () => {
  test("is one colour for every state", () => {
    // The muted token unfilled, white on a saturated ground. No third case.
    assert.match(CODE, /color: filled \? "rgba\(255,255,255,0\.85\)" : "var\(--color-fg-muted\)"/);
  });

  test("is not dimmed with the reading", () => {
    assert.doesNotMatch(blockStyle(), /opacity/, "dim is back on the whole composition, caption included");
  });
});

describe("the reading", () => {
  test("carries the dim itself", () => {
    // THREE of them, which is every element that reports something: the value,
    // the sub-line, and the progress rule. Was two before the rule was added;
    // each new reporting element has to opt in here on purpose, which is what
    // the exact count is for.
    //
    // The footer is deliberately NOT one of them: it is a qualified answer and
    // is already quieter than the sub-line, so it dims from 0.7 rather than 1.
    assert.equal((CODE.match(/opacity: dim \? 0\.45 : 1/g) ?? []).length, 3);
    assert.match(CODE, /opacity: dim \? 0\.35 : 0\.7/, "the footer stopped dimming at all");
  });

  test("still dims at the strength the rest of the app uses", () => {
    assert.match(CODE, /opacity: dim \? 0\.45 : 1/);
  });
});

describe("the reasoning", () => {
  test("is still recorded where the opacity used to be", () => {
    // Stripped from CODE above, so this looks at the real source.
    assert.match(SRC, /A caption NAMES the box/);
  });
});
