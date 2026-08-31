// A row of status widgets has to agree about what "nothing is happening" looks
// like.
//
// The streaming widgets had THREE strengths where the recorders have two: a
// dimmed 45% when unreachable, full white when live-and-unfilled, and
// `--color-fg-muted` at 70% for off air in between. On a wall beside REAPER and
// OBS — which dim when they cannot be reached — off air was the brightest quiet
// thing in the row and read as the one still doing something. Reported twice.
//
// Quiet is one thing now: off air and unreachable read at the same strength,
// because both mean nothing is going out and the WORD says which.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { withoutComments } from "../source-comments.js";

/**
 * The component's source with every comment blanked.
 *
 * COMMENTS REMOVED, once, for every assertion in this file. One of the four used
 * to strip them and the other three did not, so `assert.match(streaming(),
 * /dim:\s*!live,/)` was satisfied by a sentence about dimming and
 * `assert.doesNotMatch(status(), /var\(--green-/)` failed on one — a comment
 * naming the thing the scan looks for, which is the shape CLAUDE.md lists twice
 * among the guards here that passed on their own defect.
 *
 * Blanked character for character, so the `indexOf` cuts below land where they
 * did. The stripper is a scanner rather than a regex, and its own shapes are
 * asserted in renderer/source-comments.test.ts.
 */
const SRC = withoutComments(readFileSync(new URL("./layout-renderer.tsx", import.meta.url), "utf8"));

/** The body of the streaming readout helper, code only. */
function streaming(): string {
  const i = SRC.indexOf("const streamingReadout = (");
  assert.ok(i >= 0, "streamingReadout is gone");
  return SRC.slice(i, SRC.indexOf("\n  };", i));
}

describe("a streaming widget that is not live", () => {
  test("is dimmed, whether it is off air or unreachable", () => {
    assert.match(streaming(), /dim:\s*!live,/);
  });

  test("carries no third strength between dim and full", () => {
    // --color-fg-muted here was the 70% that made off air the brightest quiet
    // thing in the row.
    //
    // The CODE only. There was a second assertion that the comment explaining
    // the removal is still in the file, which is a test of prose: it goes red on
    // a reword with nothing wrong, stays green on a reword that says the
    // opposite, and guards no behaviour either way. A comment is worth keeping
    // because the next reader needs it, not because a test counts it.
    assert.doesNotMatch(streaming(), /color-fg-muted/, "a third quiet strength is back");
  });

  test("colours the value only when it IS live", () => {
    assert.match(streaming(), /valueColor:\s*live && !filled \? "var\(--green-10\)" : null/);
  });
});

describe("the recorders it sits beside", () => {
  function status(): string {
    const i = SRC.indexOf("const statusReadout = (");
    assert.ok(i >= 0, "statusReadout is gone");
    return SRC.slice(i, SRC.indexOf("\n  );", i));
  }

  test("dim when they cannot be reached — the strength off air now matches", () => {
    assert.match(status(), /dim=\{!s\.active && !s\.connected\}/);
  });

  test("and use red, not green — one red on a wall carrying both", () => {
    assert.match(status(), /var\(--red-(9|10)\)/);
    assert.doesNotMatch(status(), /var\(--green-/);
  });
});
