import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";

// Clicking a rail destination you are already inside must take you back to it.
//
// The rail marks a destination active by path PREFIX, which is right — while
// editing /screens/<id>/edit you ARE in Screens and it should light up. But the
// same prefix match fed the "already here, so reset instead of navigate" branch,
// so clicking Screens from the editor reset the EDITOR and left you in it.

const SRC = readFileSync(new URL("./rail.tsx", import.meta.url), "utf8");

/** The rail's rule, extracted so it can be reasoned about directly. */
function shouldReset(destPath: string, activePath: string | null, pathname: string): boolean {
  return destPath === activePath && pathname === destPath;
}

describe("clicking the destination you are already inside", () => {
  test("from a CHILD route it navigates, it does not reset", () => {
    // THE bug: from the layout editor, clicking Screens did nothing visible.
    assert.equal(shouldReset("/screens", "/screens", "/screens/view-2/edit"), false);
  });

  test("from the destination itself it resets", () => {
    // Preserved behaviour: clicking History while inside a service resets that
    // route, because navigate() to the current path is a no-op.
    assert.equal(shouldReset("/history", "/history", "/history"), true);
  });

  test("the same holds for every nested destination", () => {
    for (const [dest, child] of [
      ["/screens", "/screens/abc/edit"],
      ["/patch", "/patch/edit"],
      ["/history", "/history/2026-01-01"],
    ] as const) {
      assert.equal(shouldReset(dest, dest, child), false, `${child} should navigate to ${dest}`);
    }
  });

  test("a different destination always navigates", () => {
    assert.equal(shouldReset("/patch", "/screens", "/screens/x/edit"), false);
  });
});

describe("the rule is the one the rail actually uses", () => {
  test("the reset branch checks the pathname, not just the active match", () => {
    // Matching on `d.path === active?.path` alone is the defect.
    assert.match(
      SRC,
      /d\.path === active\?\.path && pathname === d\.path/,
      "the reset branch must require being exactly on the destination",
    );
  });
});
