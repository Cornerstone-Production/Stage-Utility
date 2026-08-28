// The rail has to be reachable in a short window.
//
// Its pane was overflow-hidden on BOTH axes, so a rail taller than the window
// simply lost its bottom. Measured at 1100x620 with a couple of consoles added:
// scrollHeight 809 against a 620 clientHeight, "Advanced" sitting at y=717, and
// nothing that could scroll anywhere in the chain above it.
//
// The rail GROWS with the operator's consoles, so "it fits" was never something
// this could assume — it only held while nobody had made many.
//
// Horizontal stays hidden on purpose: the collapse animates WIDTH, and a label
// mid-transition would put a scrollbar under the rail.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SRC = readFileSync(new URL("./split-view.tsx", import.meta.url), "utf8");

/** The class list of the pane that holds the sidebar. */
function paneClasses(): string {
  const m = /"shrink-0 h-full ([^"]*)"/.exec(SRC);
  assert.ok(m, "the sidebar pane's classes are not where this can find them");
  return m[0];
}

describe("the pane holding the rail", () => {
  test("scrolls vertically, or a tall rail is unreachable", () => {
    assert.match(paneClasses(), /overflow-y-auto/);
  });

  test("still clips horizontally, so the width animation has no scrollbar", () => {
    assert.match(paneClasses(), /overflow-x-hidden/);
  });

  test("is not hidden on both axes, which is what lost the bottom of the rail", () => {
    assert.doesNotMatch(paneClasses(), /overflow-hidden/);
  });
});
