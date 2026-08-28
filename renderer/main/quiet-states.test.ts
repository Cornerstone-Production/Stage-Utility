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

const SRC = readFileSync(new URL("./layout-renderer.tsx", import.meta.url), "utf8");

/** The body of the streaming readout helper. */
function streaming(): string {
  const i = SRC.indexOf("const streamingReadout = (");
  assert.ok(i >= 0, "streamingReadout is gone");
  return SRC.slice(i, SRC.indexOf("\n  };", i));
}

/**
 * The same, with COMMENTS REMOVED.
 *
 * The first cut of the test below searched the whole body for
 * `--color-fg-muted` and passed on the comment that explains why it was taken
 * out — a comment naming the broken thing satisfying the check for it, which is
 * a shape this repo has been caught by before. Only full-line `//` comments are
 * dropped, so nothing with code on it is swallowed.
 */
function streamingCode(): string {
  return streaming()
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("a streaming widget that is not live", () => {
  test("is dimmed, whether it is off air or unreachable", () => {
    assert.match(streaming(), /dim:\s*!live,/);
  });

  test("carries no third strength between dim and full", () => {
    // --color-fg-muted here was the 70% that made off air the brightest quiet
    // thing in the row.
    assert.doesNotMatch(streamingCode(), /color-fg-muted/, "a third quiet strength is back");
    // And the comment explaining its removal is still there to be found.
    assert.match(streaming(), /color-fg-muted/, "the reasoning went with it");
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
